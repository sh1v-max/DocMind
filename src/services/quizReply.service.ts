import { generateAnswer } from './llm.service'
import { summarizeError } from '../utils/errors'
import { QuizReplyLabel, quizReplyResponseSchema } from '../schemas/quizReply.schema'
import { QUIZ_REPLY_RULE_MAX_WORDS, QUIZ_REPLY_TIMEOUT_MS } from '../config'
import type { QuizCandidate } from './quizOffer.service'

// WF.4 — the reply reader (suspend-resume.md §4.5).
//
// A quiz run is paused at ask-user with a question on screen ("Want it?" or
// "Which document? 1. … 2. …"). The user's NEXT chat message is one of:
//   "yes" / "the second one" / "react hooks"    → choose a document
//   "no" / "not now" / "never mind"             → cancel
//   "the react one" (two React files), "both"   → unclear: ask again
//   "what is react?", "explain 2 more"          → unrelated: answer it normally
// This file turns the message into one of those four readings. It doesn't
// touch the workflow, the database or req/res, and it doesn't log: it returns
// the reading + who decided + why, and the caller logs it (the router's
// pattern, router.service.ts). WF.5 plugs it into prepareChat.
//
// Same hybrid idea as the router: FREE RULES FIRST, the LLM when they aren't
// sure.
//   - The rules only read a SHORT reply that ISN'T A QUESTION (fix 3, rule
//     17): at most 6 words, no "?", not starting with a question word, and
//     EVERY word has to be one the rules know (yes/no words, numbers and
//     ordinals, the offered filenames, a few fillers like "the" or "please").
//     One unknown word ("examples", "about", "chapter") and the rules step
//     aside. So "what is react?" or "give me 2 examples" can't be read as a
//     pick just because a filename or a number is in it.
//   - The LLM (Flash-Lite, JSON mode, temperature 0, Zod) reads the rest. Its
//     answer is only a LABEL: code checks the number it gives against the
//     list and decides what happens.
//   - Nothing here ever throws. If the LLM fails, the reply is read as
//     `unclear` (the question is asked again, nothing is lost) and the error
//     is returned for the caller to log.

// ── What comes out ──────────────────────────────────────────────────────────

export type QuizReplyReading =
  | { action: 'choose'; documentId: string; filename: string }
  | { action: 'cancel' }
  // matches = the documents to list again (all of them when nothing narrows
  // it down, or e.g. the two React files after "react")
  | { action: 'unclear'; matches: QuizCandidate[] }
  | { action: 'unrelated' }

export type QuizReplyDecision = {
  reading: QuizReplyReading
  // who decided: the free rules, the LLM, or nobody (the LLM failed → unclear)
  by: 'rule' | 'llm' | 'fallback'
  // one line for the log: which rule fired, or why the LLM was asked
  why: string
  // what went wrong on the way (already summarizeError()'d), for the caller to log
  errors: string[]
}

// The question as the user saw it. The candidates come from the run's
// snapshot (ask-user's suspend payload), so "the second one" means the second
// one SHOWN, even if a PDF was uploaded since. Same shape as the workflow's
// QuizQuestionPayload, written out here so this file doesn't reach into
// src/mastra (the boundary, rule 2).
export type QuizQuestion = { question: string; candidates: QuizCandidate[] }

// ── The rules' vocabulary ───────────────────────────────────────────────────
// Words are compared after lowercasing and removing apostrophes, so "Don't"
// is "dont" and "let's" is "lets".

// A reply starting with one of these is a question, even without a "?":
// "explain 2 more", "tell me about ww2", "summarize it". "do" is NOT here on
// purpose: "do it" is a yes (and "do you have…" fails the vocabulary check
// anyway, "you" and "have" aren't quiz-reply words).
const QUESTION_WORDS = new Set([
  'what', 'whats', 'why', 'how', 'who', 'whos', 'when', 'where', 'which', 'is', 'are', 'was', 'were',
  'does', 'did', 'can', 'could', 'would', 'should', 'will', 'explain', 'tell', 'describe',
  'summarize', 'summarise', 'define', 'compare',
])

const NO_WORDS = new Set([
  'no', 'nah', 'nope', 'nay', 'n', 'cancel', 'stop', 'never', 'nevermind', 'mind', 'skip', 'not', 'dont',
  'later', 'quit', 'exit', 'abort', 'forget',
])

// Inside the no-words: a negator in front of a stop-word flips it ("don't
// cancel" means go on), so that pair goes to the LLM.
const NEGATORS = new Set(['not', 'dont'])
const STOP_WORDS = new Set(['cancel', 'stop', 'skip', 'quit', 'exit', 'abort', 'forget'])

const YES_WORDS = new Set([
  'yes', 'yeah', 'yea', 'yep', 'yup', 'ya', 'y', 'sure', 'ok', 'okay', 'k', 'kk', 'alright', 'fine', 'go',
  'ahead', 'do', 'absolutely', 'definitely', 'course', 'sounds', 'good', 'great', 'perfect', 'cool', 'lets',
  'make', 'create', 'start', 'generate',
])

// Words that don't change the meaning: "yes PLEASE", "THE second ONE",
// "QUIZ ME ON biology", "no THANKS". On their own they say nothing, so a reply
// made only of fillers ("that one", "thanks") goes to the LLM.
const FILLER_WORDS = new Set([
  'the', 'a', 'an', 'one', 'ones', 'please', 'pls', 'plz', 'document', 'doc', 'docs', 'pdf', 'file', 'number',
  'num', 'option', 'choice', 'that', 'this', 'i', 'id', 'want', 'like', 'choose', 'pick', 'take', 'with', 'for',
  'me', 'quiz', 'on', 'from', 'it', 'of', 'now', 'thanks', 'thank', 'you', 'just', 'then',
])

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
}
const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}
// "one" is usually a filler ("the second one", "the react one"), so it only
// means 1 when it's the whole reply: "one", "number one", "option one".
const ONE_AS_NUMBER = /^(?:(?:number|option)\s+)?one$/

// "React-Hooks_v2.pdf" → ["react", "hooks", "v2"]
function filenameWords(filename: string): Set<string> {
  return new Set(
    filename
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  )
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

// "2", "#2", "2nd", "second", "two", "last" → a position in the list (1-based)
function positionOf(word: string, candidateCount: number, oneIsNumber: boolean): number | null {
  if (/^\d+$/.test(word)) return Number(word)
  const ordinal = word.match(/^(\d+)(?:st|nd|rd|th)$/)
  if (ordinal) return Number(ordinal[1])
  if (word === 'last') return candidateCount
  if (word === 'one' && oneIsNumber) return 1
  return ORDINALS[word] ?? NUMBER_WORDS[word] ?? null
}

// ── The free rules ──────────────────────────────────────────────────────────

// Returns a decision, or null = "not sure, ask the LLM" (with the reason in
// `whyNot`, for the log). Exported for the eval (npm run step8 replies).
export function readByRules(
  message: string,
  candidates: QuizCandidate[],
): { decision: QuizReplyDecision | null; whyNot?: string } {
  const rule = (reading: QuizReplyReading, why: string) => ({
    decision: { reading, by: 'rule' as const, why, errors: [] },
  })
  const askLlm = (whyNot: string) => ({ decision: null, whyNot })

  // Fix 3: the gate. A question or a long reply never reaches the rules.
  if (message.includes('?')) return askLlm('a question ("?")')
  const tokens = words(message)
  if (tokens.length === 0) return askLlm('no words (emoji or punctuation)')
  if (tokens.length > QUIZ_REPLY_RULE_MAX_WORDS) return askLlm(`longer than ${QUIZ_REPLY_RULE_MAX_WORDS} words`)
  if (QUESTION_WORDS.has(tokens[0])) return askLlm(`starts with "${tokens[0]}" (a question)`)

  const oneIsNumber = ONE_AS_NUMBER.test(tokens.join(' '))
  const nameWords = candidates.map((c) => filenameWords(c.filename))

  // Sort every word into one bucket. The order matters: a no-word wins over a
  // filename ("cancel" is cancel even next to cancel-policy.pdf), and fillers
  // are checked before filenames so "the" in the-guide.pdf can't turn
  // "the second one" into a name match.
  let sawNo = false
  let sawNegator = false
  let sawStopWord = false
  let sawYes = false
  const positions = new Set<number>()
  const positionWords: string[] = []
  const names: string[] = []
  for (const word of tokens) {
    const position = positionOf(word, candidates.length, oneIsNumber)
    const inAFilename = nameWords.some((set) => set.has(word))
    // "2024" with notes-2024.pdf is a name, not position 2024
    const outOfRangeName = position !== null && (position < 1 || position > candidates.length) && inAFilename

    if (NO_WORDS.has(word)) {
      sawNo = true
      if (NEGATORS.has(word)) sawNegator = true
      if (STOP_WORDS.has(word)) sawStopWord = true
    } else if (position !== null && !outOfRangeName) {
      positions.add(position)
      positionWords.push(word)
    } else if (YES_WORDS.has(word)) sawYes = true
    else if (FILLER_WORDS.has(word)) continue
    else if (inAFilename) names.push(word)
    // one word the rules don't know → they aren't sure what the reply means
    else return askLlm(`"${word}" isn't a quiz-reply word`)
  }

  // "no" mixed with a pick ("no, the second one", "not the first") → LLM
  if (sawNo) {
    if (sawYes || positions.size > 0 || names.length > 0) return askLlm('a no-word mixed with a choice')
    // "don't cancel" / "not stop" is two no-words that mean GO ON
    if (sawNegator && sawStopWord) return askLlm(`a negated cancel ("don't cancel")`)
    return rule({ action: 'cancel' }, 'no-words')
  }

  if (positions.size > 1) return askLlm('more than one number')
  if (positions.size === 1 && names.length > 0) return askLlm('a number and a name together')

  if (positions.size === 1) {
    const position = [...positions][0]
    if (position < 1 || position > candidates.length) {
      return rule({ action: 'unclear', matches: candidates }, `number ${position} is out of range (1–${candidates.length})`)
    }
    const picked = candidates[position - 1]
    // "2" when the files are lecture-2.pdf and lecture-1.pdf, in that order:
    // the 2nd in the list is lecture-1, but the name says lecture-2. Don't guess.
    const alsoNamed = candidates.filter((c, i) => c !== picked && positionWords.some((w) => nameWords[i].has(w)))
    if (alsoNamed.length > 0) {
      return rule({ action: 'unclear', matches: [picked, ...alsoNamed] }, `"${positionWords[0]}" is a position AND part of a filename`)
    }
    return rule({ action: 'choose', documentId: picked.documentId, filename: picked.filename }, `position ${position}`)
  }

  if (names.length > 0) {
    // every name word must be in the same filename: "react hooks" → only
    // react-hooks.pdf; "react" alone → both React files → ask again with those two
    const all = candidates.filter((_, i) => names.every((w) => nameWords[i].has(w)))
    if (all.length === 1) {
      return rule({ action: 'choose', documentId: all[0].documentId, filename: all[0].filename }, `name "${names.join(' ')}"`)
    }
    const some = candidates.filter((_, i) => names.some((w) => nameWords[i].has(w)))
    return rule({ action: 'unclear', matches: all.length > 1 ? all : some }, `name "${names.join(' ')}" matches ${all.length > 1 ? all.length : 'no single'} file(s)`)
  }

  if (sawYes) {
    if (candidates.length === 1) {
      return rule({ action: 'choose', documentId: candidates[0].documentId, filename: candidates[0].filename }, 'yes-words, one document')
    }
    return rule({ action: 'unclear', matches: candidates }, `yes-words, but ${candidates.length} documents`)
  }

  return askLlm('only filler words')
}

// ── The LLM ─────────────────────────────────────────────────────────────────

// What the model sees: the question exactly as shown, the numbered list, the
// four labels with the traps spelled out, the reply last (the router's order).
export function buildReplyPrompt(message: string, question: QuizQuestion): string {
  const list = question.candidates.map((c, i) => `${i + 1}. ${c.filename}`).join('\n')
  return `You read replies in DocMind, an app where users chat with PDF documents they uploaded.
The assistant offered to make a 5-question multiple-choice quiz and asked:
"""
${question.question}
"""
The documents it offered, numbered as the user saw them:
${list}

Classify the user's reply into exactly one action:
- choose: the user clearly accepts the quiz or picks one document. Set "choice" to that document's number. With only one document, a yes means choice 1.
- cancel: the user declines, or doesn't want a quiz now.
- unclear: the user is answering the question, but it isn't clear which single document they mean (it matches several, they say "both", or they hesitate).
- unrelated: the reply is not an answer to the question: a question about what a document says, a different request, or small talk. A question that mentions a document's name or number is still unrelated, for example "what is in the second one?" or "explain 2 more".
"choice" is null unless the action is choose.

Reply: ${JSON.stringify(message)}`
}

// One Flash-Lite call → a reading. The model's number is checked here: a
// choose without a valid number is NOT a guess, it's `unclear`.
async function readByLlm(message: string, question: QuizQuestion): Promise<{ reading: QuizReplyReading; invalid?: string }> {
  const { candidates } = question
  const raw = await generateAnswer(
    buildReplyPrompt(message, question),
    { responseMimeType: 'application/json', responseSchema: quizReplyResponseSchema, temperature: 0 },
    { timeoutMs: QUIZ_REPLY_TIMEOUT_MS },
  )

  let label: QuizReplyLabel
  try {
    const parsed = QuizReplyLabel.safeParse(JSON.parse(raw))
    if (!parsed.success) return { reading: { action: 'unclear', matches: candidates }, invalid: `not a valid label: ${raw.slice(0, 120)}` }
    label = parsed.data
  } catch {
    return { reading: { action: 'unclear', matches: candidates }, invalid: `not JSON: ${raw.slice(0, 120)}` }
  }

  if (label.action === 'choose') {
    const position = label.choice ?? (candidates.length === 1 ? 1 : null)
    if (position === null || position < 1 || position > candidates.length) {
      return { reading: { action: 'unclear', matches: candidates }, invalid: `choose without a valid number (${label.choice})` }
    }
    const picked = candidates[position - 1]
    return { reading: { action: 'choose', documentId: picked.documentId, filename: picked.filename } }
  }
  if (label.action === 'unclear') return { reading: { action: 'unclear', matches: candidates } }
  return { reading: { action: label.action } }
}

// ── The hybrid: what WF.5's prepareChat calls ───────────────────────────────

export async function interpretQuizReply(message: string, question: QuizQuestion): Promise<QuizReplyDecision> {
  const byRules = readByRules(message, question.candidates)
  if (byRules.decision) return byRules.decision

  const asked = `LLM (${byRules.whyNot})`
  try {
    const { reading, invalid } = await readByLlm(message, question)
    if (invalid) return { reading, by: 'fallback', why: asked, errors: [`reply reader: ${invalid}`] }
    return { reading, by: 'llm', why: asked, errors: [] }
  } catch (err) {
    // Gemini down / 429 / the 15 s limit: ask again rather than guess. Nothing
    // is lost: the run is still waiting, and "cancel" always works.
    return { reading: { action: 'unclear', matches: question.candidates }, by: 'fallback', why: asked, errors: [summarizeError(err)] }
  }
}

// ── "Ask again" text for an unclear reply (WF.5 sends it, no Mastra call) ──
// The documents keep the numbers they had in the first question, so after
// "react" → "2. react-intro.pdf  3. react-hooks.pdf", typing "3" still means
// react-hooks.pdf.
export function askAgainText(question: QuizQuestion, matches: QuizCandidate[]): string {
  const { candidates } = question
  if (candidates.length === 1) {
    return `Should I make the quiz from **${candidates[0].filename}**? Say yes, or cancel.`
  }
  const narrowed = matches.length > 0 && matches.length < candidates.length
  const list = (narrowed ? matches : candidates)
    .map((m) => ({ n: candidates.findIndex((c) => c.documentId === m.documentId) + 1, filename: m.filename }))
    .sort((a, b) => a.n - b.n)
    .map((m) => `${m.n}. **${m.filename}**`)
    .join('\n')
  const lead = narrowed ? 'Which one do you mean?' : 'Which document should the quiz be on?'
  return `${lead}\n\n${list}\n\nReply with its number or name, or say cancel.`
}
