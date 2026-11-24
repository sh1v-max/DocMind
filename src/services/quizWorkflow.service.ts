import { randomUUID } from 'node:crypto'
import { getQuizWorkflow } from '../mastra'
import {
  QuizQuestionPayload,
  QuizReply,
  QuizWorkflowResult,
} from '../mastra/workflows/quiz.workflow'
import {
  type ActiveQuizRun,
  claimWaitingRun,
  createActiveRun,
  findActiveRun,
  findRunForUser,
  markDone,
  markWaiting,
} from '../repositories/quizWorkflowRuns.repository'
import { checkDocumentReady } from './documents.service'
import { buildQuizOffer, listQuizCandidates, nothingReadyText, type QuizCandidate, type QuizOffer } from './quizOffer.service'
import { ALL_DOCUMENTS } from '../config'
import type { Quiz } from '../schemas/quiz.schema'
import { failed, workflowDetail } from '../utils/pipelineLogger'
import { summarizeError } from '../utils/errors'

// WF.3 — the quiz workflow as DocMind sees it (suspend-resume.md §4.1–§4.4).
//
// The ONLY file outside src/mastra/ that imports Mastra (rule 2). Everything
// else (the chat routes in WF.5, the button route) calls these functions and
// gets plain DocMind-shaped results back, the same way only repositories/
// touches SQL. Swapping Mastra for something else later would touch only
// src/mastra/ and this file.
//
// Two records per run, kept in step here:
//   - Mastra's snapshot (schema mastra): where the run IS (paused at ask-user,
//     its question and choices). Mastra's business.
//   - DocMind's pointer row (quiz_workflow_runs): WHOSE run it is, in WHICH
//     chat, and whether it's 'running' / 'waiting' / 'done'. Our business:
//     ownership, one-per-chat, expiry and the claim all live there.
//
// Like every service: never touches req/res, returns results instead of
// sending responses (the route decides what goes on the wire).

// ── Result shapes ───────────────────────────────────────────────────────────

// How a run ended, with the sentence the user sees (saved to chat history as
// the assistant's reply in WF.5).
export type QuizRunEnding =
  | { outcome: 'quiz'; text: string; documentId: string; filename: string; quiz: Quiz }
  | { outcome: 'cancelled' | 'nothing_ready' | 'error'; text: string }

export type StartQuizRunResult =
  // D10: no ready document → a sentence, NO run and NO rows
  | { kind: 'nothing_ready'; text: string }
  // paused at ask-user: show `text`, and (WF.6) buttons for `candidates`
  | { kind: 'asked'; runId: string; text: string; candidates: QuizCandidate[] }
  // a quiz is already being made in this chat (one active run per chat)
  | { kind: 'busy'; text: string }
  // the run ended without pausing (only the nothing_ready guard can do that)
  | { kind: 'ended'; runId: string; ending: QuizRunEnding }
  // fix 5: Mastra or its storage failed → today's offer + button instead
  | { kind: 'fallback'; offer: QuizOffer }

export type ResumeQuizRunResult =
  | { ok: true; runId: string; ending: QuizRunEnding }
  | { ok: false; status: number; error: string }

// The pointer row + (when it's waiting) the question it's waiting on. What
// prepareChat (WF.5) needs to read the user's next message in context.
export type ActiveQuizRunInfo = ActiveQuizRun & { question: QuizQuestionPayload | null }

// User-facing sentences (shown in the chat, so plain and short)
const BUSY_TEXT = 'Your quiz is still being made, it will show up here in a moment.'
const ALREADY_TAKEN_TEXT = 'That quiz is already being made, or it has ended.'
const EXPIRED_TEXT = 'That quiz offer expired. Say "quiz me" to start a new one.'

// Mastra error ids that mean "someone else already resumed this run" or "it
// isn't paused any more" (finished / cancelled). WF.1 showed the loser of a
// race can get EITHER, so both are a normal outcome, not a crash (rule 7).
const ALREADY_TAKEN_IDS = new Set(['WORKFLOW_RESUME_ALREADY_CLAIMED', 'WORKFLOW_RUN_NOT_SUSPENDED'])

const short = (runId: string) => runId.slice(0, 8)
const mastraErrorId = (err: unknown) => (err as { id?: string })?.id

// ── Start ───────────────────────────────────────────────────────────────────
// "quiz me" → check there's something to quiz on (D10) → write the pointer
// row → start the Mastra run → it pauses at ask-user → mark the row waiting.
//
// documentId: the chat's one document, or undefined / 'all' for "All documents".
export async function startQuizRun(input: {
  userId: string
  sessionId: string
  documentId?: string
}): Promise<StartQuizRunResult> {
  const { userId, sessionId } = input
  const documentId = input.documentId && input.documentId !== ALL_DOCUMENTS ? input.documentId : undefined

  // D10 — 0 ready documents: answer with a sentence and create NOTHING (no
  // pointer row, no Mastra snapshot for a quiz that could never start).
  // `one` is kept for the fallback offer, which needs the filename.
  let one: { documentId: string; filename: string } | undefined
  if (documentId) {
    const check = await checkDocumentReady(documentId, userId)
    if (!check.ok) return { kind: 'nothing_ready', text: check.error }
    one = { documentId, filename: check.filename }
  } else {
    const { candidates, processing } = await listQuizCandidates(userId)
    if (candidates.length === 0) return { kind: 'nothing_ready', text: nothingReadyText(processing) }
  }

  // The pointer row goes in BEFORE start() (fix 2): the unique index makes a
  // second "quiz me" in the same chat fail here, so two runs can never exist
  // for one chat, and a crash right after start() still leaves a row that the
  // 3-min stale rule can close.
  const runId = randomUUID()
  if (!(await insertPointer(runId, userId, sessionId))) {
    workflowDetail(`a quiz is already being made in session ${short(sessionId)} → busy`)
    return { kind: 'busy', text: BUSY_TEXT }
  }

  workflowDetail(`run ${short(runId)}: started (${documentId ? 'one document' : 'all documents'})`)
  let result
  let mastraLoaded = false
  try {
    const { workflow } = await getQuizWorkflow()
    mastraLoaded = true
    // We choose the runId (randomUUID above) so the pointer row could be
    // written first. resourceId = the owner, only for reading the snapshot
    // table by eye; DocMind never looks runs up through it.
    const run = await workflow.createRun({ runId, resourceId: userId })
    result = await run.start({ inputData: { userId, documentId } })
  } catch (err) {
    // fix 5 — Mastra couldn't be built, or its storage failed. Close the
    // pointer so the chat isn't blocked, and give today's offer + button.
    return fallback(runId, userId, one, err, mastraLoaded)
  }

  if (result.status === 'suspended') {
    const payload = QuizQuestionPayload.safeParse(
      (result.suspendPayload as Record<string, unknown> | undefined)?.['ask-user'],
    )
    if (!payload.success) {
      return fallback(runId, userId, one, new Error(`unexpected suspend payload: ${payload.error.message}`), true)
    }

    // markWaiting is false only if the row stopped being 'running' while
    // start() ran (e.g. the chat was deleted meanwhile, WF.5). Then nobody
    // can answer this run: drop it.
    if (!(await markWaiting(runId, userId))) {
      await discardRun(runId, 'its pointer row was closed while it started')
      return { kind: 'ended', runId, ending: { outcome: 'cancelled', text: 'Okay, no quiz.' } }
    }
    workflowDetail(`run ${short(runId)}: paused at ask-user (${payload.data.candidates.length} candidate(s)), waiting up to 30 min`)
    return { kind: 'asked', runId, text: payload.data.question, candidates: payload.data.candidates }
  }

  if (result.status === 'success') {
    // Only the resolve-document guard can end a run before it pauses.
    const ending = await finishRun(runId, userId, result.result)
    return { kind: 'ended', runId, ending }
  }

  // 'failed' / 'canceled' / anything else: steps catch their own errors (rule
  // 15), so this means Mastra itself had a problem → fallback (rule 19).
  return fallback(runId, userId, one, result.status === 'failed' ? result.error : new Error(`status ${result.status}`), true)
}

// The insert, plus what to do when the chat already has an active run:
//   - waiting (the user ignored the question and asked again), expired, or
//     stale (its process died mid-step): close it, then insert again once.
//   - running and fresh: a quiz really is being made → false (busy).
async function insertPointer(runId: string, userId: string, sessionId: string): Promise<boolean> {
  if (await createActiveRun(runId, userId, sessionId)) return true

  const active = await findActiveRun(sessionId, userId)
  if (active?.status === 'running' && !active.stale) return false
  if (active) {
    const why = active.status === 'waiting' ? (active.expired ? 'expired' : 'superseded by a new "quiz me"') : 'stale (running > 3 min)'
    await cancelQuizRun(active.runId, userId, why)
  }
  return createActiveRun(runId, userId, sessionId)
}

// fix 5 — the pointer row is closed, whatever Mastra left is cleaned up (best
// effort), the cause is logged, and the user gets the AG.5 offer + button.
// `mastraLoaded` = Mastra itself came up (the failure was later). If it
// didn't, there's no snapshot to clean, and trying would mean a SECOND failed
// setup (seconds) before the user sees the offer.
async function fallback(
  runId: string,
  userId: string,
  one: { documentId: string; filename: string } | undefined,
  err: unknown,
  mastraLoaded: boolean,
): Promise<StartQuizRunResult> {
  failed(`run ${short(runId)}: could not start the quiz workflow → falling back to the offer + button`)
  console.error(summarizeError(err))
  await markDone(runId, userId)
  if (mastraLoaded) await discardRun(runId, 'start failed')
  return { kind: 'fallback', offer: await buildQuizOffer(userId, one) }
}

// ── Resume ──────────────────────────────────────────────────────────────────
// The user answered (a typed reply read by WF.4, or a button in WF.6):
//   find the row (404 if not yours) → check the choice against the list that
//   was shown (400) → CLAIM the row (409 if someone else got it first) →
//   Mastra resume → close the row + delete the snapshot.
export async function resumeQuizRun(input: {
  userId: string
  runId: string
  reply: QuizReply
}): Promise<ResumeQuizRunResult> {
  const { userId, runId, reply } = input

  // Rule 5: someone else's run = 404, exactly like a run that doesn't exist.
  const pointer = await findRunForUser(runId, userId)
  if (!pointer) return { ok: false, status: 404, error: 'No quiz found' }
  if (pointer.status !== 'waiting') return { ok: false, status: 409, error: ALREADY_TAKEN_TEXT }

  // Rule 6: a chosen document must be one of the candidates the user SAW.
  // Checked BEFORE the claim, so a bad id doesn't use up the user's question.
  if (reply.action === 'choose') {
    const question = await readQuestion(runId)
    if (!question) {
      // the pointer says waiting, but Mastra has no paused run (its snapshot
      // was deleted or the run ended): nothing to resume, close the row.
      await cancelQuizRun(runId, userId, 'no paused run in Mastra')
      return { ok: false, status: 409, error: ALREADY_TAKEN_TEXT }
    }
    if (!question.candidates.some((c) => c.documentId === reply.documentId)) {
      return { ok: false, status: 400, error: "That document isn't one of the choices." }
    }
  }

  // THE CLAIM (rule 7). One conditional UPDATE: only one caller can move the
  // row waiting → running. A click and a typed "yes" at the same moment both
  // get here; the loser gets null and Mastra is never called for it.
  const claimed = await claimWaitingRun(runId, userId)
  if (!claimed) {
    const again = await findActiveRun(pointer.sessionId, userId)
    if (again?.runId === runId && again.expired) {
      await cancelQuizRun(runId, userId, 'expired')
      return { ok: false, status: 409, error: EXPIRED_TEXT }
    }
    workflowDetail(`run ${short(runId)}: claim lost (already taken)`)
    return { ok: false, status: 409, error: ALREADY_TAKEN_TEXT }
  }
  workflowDetail(`run ${short(runId)}: claimed, resuming with ${reply.action}`)

  let result
  try {
    const { workflow } = await getQuizWorkflow()
    // createRun with an EXISTING runId loads that run from storage; resume()
    // then runs ask-user again from its first line, this time with resumeData.
    const run = await workflow.createRun({ runId })
    result = await run.resume({ step: 'ask-user', resumeData: reply })
  } catch (err) {
    // Our claim won, but Mastra says the run isn't paused any more (it was
    // cancelled / finished outside this path). A normal outcome (rule 7).
    if (ALREADY_TAKEN_IDS.has(mastraErrorId(err) ?? '')) {
      workflowDetail(`run ${short(runId)}: Mastra refused the resume (${mastraErrorId(err)})`)
      await markDone(runId, userId)
      await discardRun(runId, 'Mastra refused the resume')
      return { ok: false, status: 409, error: ALREADY_TAKEN_TEXT }
    }
    // Anything else (storage down, ...): close the row so the chat isn't
    // stuck on "still being made", then let the route's error handling answer
    // (503 / event: error), as §4.8 says.
    failed(`run ${short(runId)}: resume failed`)
    await markDone(runId, userId)
    await discardRun(runId, 'resume failed')
    throw err
  }

  if (result.status !== 'success') {
    // Steps never throw (rule 15), so this is Mastra itself failing.
    failed(`run ${short(runId)}: resume ended with status '${result.status}'`)
    if (result.status === 'failed') console.error(summarizeError(result.error))
  }
  const ending = await finishRun(runId, userId, result.status === 'success' ? result.result : undefined)
  return { ok: true, runId, ending }
}

// ── Cancel (runs nobody is answering) ───────────────────────────────────────
// D9: a cancel the USER types or clicks goes through resumeQuizRun with
// { action: 'cancel' } (bail → 'cancelled'), so it passes the same claim as a
// "yes". This is for the other cases: expired, an unrelated message,
// superseded by a new "quiz me", a stale run, a deleted chat or document.
//
// Order: close OUR row first (so nothing can claim it any more), then tell
// Mastra and delete its snapshot. Mastra failures are logged, not thrown: the
// row is already 'done', so the chat is unblocked whatever happens, and the
// daily prune catches a snapshot that couldn't be deleted.
// Returns false when the run isn't this user's (or doesn't exist).
export async function cancelQuizRun(runId: string, userId: string, reason: string): Promise<boolean> {
  if (!(await markDone(runId, userId))) return false
  workflowDetail(`run ${short(runId)}: cancelled (${reason})`)
  await discardRun(runId, reason, true)
  return true
}

// ── Find ────────────────────────────────────────────────────────────────────
// "Is a quiz active in this chat?" — read by prepareChat on every message
// (WF.5), BEFORE the embedding. Only a waiting, unexpired run needs Mastra
// (to know the question and the choices); everything else is the pointer row.
export async function findActiveQuizRun(sessionId: string, userId: string): Promise<ActiveQuizRunInfo | null> {
  const active = await findActiveRun(sessionId, userId)
  if (!active) return null
  const question = active.status === 'waiting' && !active.expired ? await readQuestion(active.runId) : null
  return { ...active, question }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// The question a paused run is waiting on, read from Mastra's snapshot (the
// suspend payload of ask-user). null if the run isn't paused there.
async function readQuestion(runId: string): Promise<QuizQuestionPayload | null> {
  const { workflow } = await getQuizWorkflow()
  const state = await workflow.getWorkflowRunById(runId, { fields: ['steps'] })
  if (!state || state.status !== 'suspended') return null
  const step = state.steps?.['ask-user']
  const payload = QuizQuestionPayload.safeParse(Array.isArray(step) ? undefined : step?.suspendPayload)
  return payload.success ? payload.data : null
}

// A run ended: read its outcome, close the pointer row, delete the snapshot
// (fix 4, D8: no quiz content outlives its run), and word the reply.
async function finishRun(runId: string, userId: string, rawResult: unknown): Promise<QuizRunEnding> {
  const parsed = QuizWorkflowResult.safeParse(rawResult)
  const result: QuizWorkflowResult = parsed.success
    ? parsed.data
    : { outcome: 'error', status: 500, message: 'The quiz workflow ended without a readable result' }

  await markDone(runId, userId)
  await discardRun(runId, `ended: ${result.outcome}`)
  workflowDetail(`run ${short(runId)}: ended → ${result.outcome}${result.outcome === 'error' ? ` (${result.status})` : ''}`)

  switch (result.outcome) {
    case 'quiz':
      return { outcome: 'quiz', text: `Here's your quiz on **${result.filename}**.`, documentId: result.documentId, filename: result.filename, quiz: result.quiz }
    case 'cancelled':
      return { outcome: 'cancelled', text: 'Okay, no quiz.' }
    case 'nothing_ready':
      return { outcome: 'nothing_ready', text: "None of your documents is ready for a quiz right now." }
    case 'error':
      return { outcome: 'error', text: errorText(result.status) }
  }
}

function errorText(status: number): string {
  if (status === 404) return "That document isn't available any more, so I couldn't make the quiz."
  if (status === 409) return "That document isn't ready right now, so I couldn't make the quiz."
  return 'I couldn\'t make the quiz right now. Say "quiz me" to try again.'
}

// Remove Mastra's record of a run (fix 4): optionally cancel it first (for a
// paused run nobody is answering, D9), then delete its snapshot. Best effort:
// errors are logged, never thrown, because the pointer row is already closed.
// (Mastra's small lease row in mastra_workflow_run_owners stays until the
// daily prune; it holds no quiz content.)
async function discardRun(runId: string, reason: string, cancelFirst = false): Promise<void> {
  try {
    const { workflow } = await getQuizWorkflow()
    if (cancelFirst) {
      const run = await workflow.createRun({ runId })
      await run.cancel()
    }
    await workflow.deleteWorkflowRunById(runId)
    workflowDetail(`run ${short(runId)}: snapshot deleted (${reason})`)
  } catch (err) {
    workflowDetail(`run ${short(runId)}: could not delete the snapshot (${reason}); the daily prune will`)
    console.error(summarizeError(err))
  }
}
