import { z } from 'zod'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { Quiz } from '../../schemas/quiz.schema'
import { checkDocumentReady } from '../../services/documents.service'
import { listQuizCandidates } from '../../services/quizOffer.service'
import { generateQuiz } from '../../services/quiz.service'
import { QUIZ_GENERATE_TIMEOUT_MS } from '../../config'
import { failed, workflowDetail } from '../../utils/pipelineLogger'
import { summarizeError } from '../../utils/errors'

// WF.3 — the quiz workflow (suspend-resume.md §4.2).
//
//   resolve-document ──► ask-user ──⏸ waits for the user──► generate-quiz
//   (which documents?)   (suspend with the        (the EXISTING generateQuiz:
//                         question + the list)     ownership, ready, Zod, shuffle)
//
// Rule 1 — Mastra orchestrates, DocMind decides. No step contains business
// logic of its own: each one calls a service that already exists
// (checkDocumentReady, listQuizCandidates, generateQuiz). The workflow only
// adds what those services can't do alone: remember, between two HTTP
// requests (and across a restart), that a question was asked and what the
// choices were.
//
// Every run ends as Mastra status 'success' with one of four outcomes:
//   quiz           the quiz was made
//   cancelled      the user said no (ask-user's bail, D9)
//   nothing_ready  no ready document left (a guard; the service checks first, D10)
//   error          generating failed in any way (rule 15: a step never throws)
// bail() ALSO ends as 'success' (WF.1), so callers read `outcome`, never just
// the status (rule 8).

// ── Schemas: the typed edges between steps (Zod 4, same as the app) ────────

// A document the user can pick. Exactly what the user is shown: an id and a
// filename. Never chunks or quiz text (rule 9).
export const QuizCandidateSchema = z.object({ documentId: z.string(), filename: z.string() })

// What starts a run. userId comes from req.user.id via the service (rule 4),
// never from the client. documentId absent = an "All documents" chat.
export const QuizWorkflowInput = z.object({
  userId: z.string(),
  documentId: z.string().optional(),
})

// resolve-document → ask-user
const Resolved = z.object({
  userId: z.string(),
  candidates: z.array(QuizCandidateSchema).min(1),
})

// What ask-user saves when it pauses (its suspend payload): the question as
// the user saw it, and the list it refers to. Saved in the snapshot, so "the
// second one" is matched against THIS list, even if the user uploads another
// PDF while the question is waiting.
export const QuizQuestionPayload = z.object({
  question: z.string(),
  candidates: z.array(QuizCandidateSchema).min(1),
})
export type QuizQuestionPayload = z.infer<typeof QuizQuestionPayload>

// What ask-user accepts when it's resumed. Only two shapes, ever: the reply
// reader (WF.4) and the buttons (WF.6) turn whatever the user did into one of
// these. "yes" with a single candidate arrives as choose-that-one. Mastra
// validates resumeData against this before the step runs (validateInputs).
export const QuizReply = z.discriminatedUnion('action', [
  z.object({ action: z.literal('choose'), documentId: z.string() }),
  z.object({ action: z.literal('cancel') }),
])
export type QuizReply = z.infer<typeof QuizReply>

// ask-user → generate-quiz
const Chosen = z.object({ userId: z.string(), documentId: z.string(), filename: z.string() })

// How a run ends (the workflow's result, or a bail payload).
export const QuizWorkflowResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('quiz'), documentId: z.string(), filename: z.string(), quiz: Quiz }),
  z.object({ outcome: z.literal('cancelled') }),
  z.object({ outcome: z.literal('nothing_ready') }),
  // status = the HTTP-style code generateQuiz returned (404 / 409 / 502), or
  // 503 for anything thrown (Gemini 503/429, the 60 s timeout, a DB error)
  z.object({ outcome: z.literal('error'), status: z.number(), message: z.string() }),
])
export type QuizWorkflowResult = z.infer<typeof QuizWorkflowResult>

// The question ask-user asks. A pure function of the list: nothing here may
// have a side effect, because it runs above the suspend check (rule 8b).
export function questionFor(candidates: z.infer<typeof QuizCandidateSchema>[]): string {
  if (candidates.length === 1) {
    return `I can make a 5-question multiple-choice quiz from **${candidates[0].filename}**. Want it?`
  }
  const list = candidates.map((c, i) => `${i + 1}. **${c.filename}**`).join('\n')
  return `Which document should the quiz be on?\n\n${list}\n\nReply with its number or name, or say cancel.`
}

// ── Step 1: which documents could the quiz use? ─────────────────────────────
// Never pauses. One-document chat → that document, if it's still the caller's
// and ready. "All documents" → every ready document of the caller (the same
// helper the old offer uses, so the rule lives once).
//
// The service already checked this before start() (D10: 0 ready → no run at
// all). The bail here only catches a document deleted in the few milliseconds
// between that check and this step.
const resolveDocument = createStep({
  id: 'resolve-document',
  inputSchema: QuizWorkflowInput,
  outputSchema: Resolved,
  execute: async ({ inputData, bail }) => {
    const { userId, documentId } = inputData

    let candidates: z.infer<typeof QuizCandidateSchema>[]
    if (documentId) {
      const check = await checkDocumentReady(documentId, userId)
      candidates = check.ok ? [{ documentId, filename: check.filename }] : []
    } else {
      candidates = (await listQuizCandidates(userId)).candidates
    }

    if (candidates.length === 0) {
      workflowDetail('resolve-document: nothing ready any more → bail nothing_ready')
      return bail({ outcome: 'nothing_ready' as const })
    }
    workflowDetail(`resolve-document: ${candidates.length} candidate(s): ${candidates.map((c) => c.filename).join(', ')}`)
    return { userId, candidates }
  },
})

// ── Step 2: ask the user, and WAIT ──────────────────────────────────────────
// The pause point. execute() runs TWICE per run (WF.0/WF.1 proved it):
//   1st time (inside start()):  no resumeData → suspend(question) → the
//      snapshot is saved to Postgres, start() returns 'suspended', the HTTP
//      request ends. Nothing is in memory any more.
//   2nd time (inside resume(), maybe another request, another process):
//      runs again FROM THE FIRST LINE, now with resumeData = the user's answer.
// So the first line must be the suspend check, with nothing expensive or
// side-effecting above it (rule 8b). Building the question text is pure.
//
// One step for both questions (simplification S): one candidate → "Want it?",
// several → "Which one?". Picking a document = yes.
const askUser = createStep({
  id: 'ask-user',
  inputSchema: Resolved,
  outputSchema: Chosen,
  suspendSchema: QuizQuestionPayload,
  resumeSchema: QuizReply,
  execute: async ({ inputData, resumeData, suspend, bail }) => {
    const { userId, candidates } = inputData

    if (!resumeData) {
      return await suspend({ question: questionFor(candidates), candidates })
    }

    // D9 — a cancel the user typed or clicked comes in HERE, through the same
    // claim as a "yes", so a cancel and a yes can't both win. bail() ends the
    // run ('success' + this payload) and generate-quiz never runs.
    if (resumeData.action === 'cancel') {
      workflowDetail('ask-user: resumed with cancel → bail cancelled')
      return bail({ outcome: 'cancelled' as const })
    }

    // Rule 6 — the choice must be one of the documents that were SHOWN
    // (inputData.candidates is restored from the snapshot). The service checks
    // this before claiming too; this is the second guard, so a bad id can never
    // reach generateQuiz.
    const shown: z.infer<typeof QuizCandidateSchema>[] = candidates
    const chosen = shown.find((c) => c.documentId === resumeData.documentId)
    if (!chosen) {
      workflowDetail(`ask-user: ${resumeData.documentId} wasn't one of the choices → bail error`)
      return bail({ outcome: 'error' as const, status: 400, message: "That document wasn't one of the choices." })
    }

    workflowDetail(`ask-user: resumed, chose "${chosen.filename}"`)
    return { userId, documentId: chosen.documentId, filename: chosen.filename }
  },
})

// ── Step 3: make the quiz (the existing generateQuiz, unchanged) ────────────
// generateQuiz re-checks ownership + ready (rule 11: time passed while the
// run was paused), samples chunks, asks Gemini in structured mode, validates
// with Zod, retries ONE invalid reply, shuffles. What it does NOT do is catch
// a Gemini HTTP error (503, 429) or a hang: those THROW. A throw inside a step
// would end the run 'failed' and leave the pointer row 'running', so this step
// catches everything and turns it into an `error` outcome (fix 1, rule 15).
//
// No Mastra retries (`retries` is left unset): generateQuiz already retries
// once, and more would spend free-tier Gemini calls.
const generateQuizStep = createStep({
  id: 'generate-quiz',
  inputSchema: Chosen,
  outputSchema: QuizWorkflowResult,
  execute: async ({ inputData }) => {
    const { userId, documentId, filename } = inputData
    workflowDetail(`generate-quiz: "${filename}" (Gemini timeout ${QUIZ_GENERATE_TIMEOUT_MS / 1000} s per attempt)`)

    try {
      const result = await generateQuiz({ documentId, userId, timeoutMs: QUIZ_GENERATE_TIMEOUT_MS }, Date.now())
      if (result.ok) {
        return { outcome: 'quiz' as const, documentId, filename, quiz: result.quiz }
      }
      // 404 (deleted meanwhile), 409 (not ready), 502 (invalid twice)
      workflowDetail(`generate-quiz: generateQuiz said ${result.status} → error outcome`)
      return { outcome: 'error' as const, status: result.status, message: result.error }
    } catch (err) {
      failed('generate-quiz threw (caught, the run still ends cleanly)')
      console.error(summarizeError(err))
      return { outcome: 'error' as const, status: 503, message: 'Quiz generation failed' }
    }
  },
})

// ── The workflow ────────────────────────────────────────────────────────────
// - validateInputs: Mastra checks the start input and every resumeData with
//   the Zod schemas above, so a malformed reply throws BEFORE any step runs.
// - autoRestartActiveRuns: false — belt and braces with recovery 'off' (D5):
//   a run that was mid-generate when the process died must not be re-driven
//   (it would spend a Gemini call on a quiz nobody is waiting for). WF.1
//   showed that only Mastra's own server calls the restart sweep anyway.
// The id is the `workflow_name` column in mastra.mastra_workflow_snapshot.
export const quizWorkflow = createWorkflow({
  id: 'quiz-workflow',
  inputSchema: QuizWorkflowInput,
  outputSchema: QuizWorkflowResult,
  options: { validateInputs: true, autoRestartActiveRuns: false },
})
  .then(resolveDocument)
  .then(askUser)
  .then(generateQuizStep)
  .commit()
