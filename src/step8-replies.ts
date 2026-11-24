import chalk from 'chalk'
import { pipelineStart, pipelineEnd } from './utils/pipelineLogger'
import {
  readByRules,
  interpretQuizReply,
  askAgainText,
  type QuizQuestion,
  type QuizReplyDecision,
  type QuizReplyReading,
} from './services/quizReply.service'
import type { QuizCandidate } from './services/quizOffer.service'

// WF.4 — the reply reader EVAL (suspend-resume.md §6 WF.4). Run through step8:
//   npm run step8 replies          rules + the LLM on every reply the rules
//                                  don't take (Flash-Lite, paced 5 s apart)
//   npm run step8 replies rules    rules only, 0 API calls: shows which replies
//                                  the rules take and which would go to the LLM
//
// No database, no Mastra, no DocMind data: fake candidate lists, labelled
// replies. Same idea as step7 (the router eval): a reader that's wrong doesn't
// crash anything, so it has to be MEASURED. What counts:
//   harmful   a CHOICE that isn't right: a "no" read as a pick, the wrong
//             document picked, or a real question read as a pick (fix 3's
//             trap set). Must be 0.
//   annoying  anything else that's off: "yes" read as unclear (asked again),
//             a question read as a cancel (the quiz is dropped and the
//             question isn't answered). Worth knowing, not dangerous.

const PAUSE_MS = 5000
const RETRY_AFTER_429_MS = 30_000

// ── Fake candidate lists (as the user would have seen them) ─────────────────
const c = (documentId: string, filename: string): QuizCandidate => ({ documentId, filename })
const ONE = [c('d-react', 'react-intro.pdf')]
const TWO_REACT = [c('d-intro', 'react-intro.pdf'), c('d-hooks', 'react-hooks.pdf')]
const THREE = [c('d-bio', 'biology-notes.pdf'), c('d-react', 'react-intro.pdf'), c('d-hist', 'history-ww2.pdf')]
// the trap for numbers: lecture-2.pdf is shown FIRST, so "2" (2nd in the list)
// and "lecture-2" disagree
const LECTURES = [c('d-l2', 'lecture-2.pdf'), c('d-l1', 'lecture-1.pdf'), c('d-l3', 'lecture-3.pdf')]

// The question text, same wording as quiz.workflow.ts's questionFor() (not
// imported: that file imports Mastra, and this eval doesn't need it)
function questionFor(candidates: QuizCandidate[]): string {
  if (candidates.length === 1) {
    return `I can make a 5-question multiple-choice quiz from **${candidates[0].filename}**. Want it?`
  }
  const list = candidates.map((x, i) => `${i + 1}. **${x.filename}**`).join('\n')
  return `Which document should the quiz be on?\n\n${list}\n\nReply with its number or name, or say cancel.`
}

// ── The labelled set ────────────────────────────────────────────────────────
// expect: 'choose:<documentId>' | 'cancel' | 'unclear' | 'unrelated', or a
// list when two readings are both fine. trap = fix 3's set: a real question
// that contains a filename, a number or an ordinal.
type Expect = string
type Item = { list: QuizCandidate[]; reply: string; expect: Expect | Expect[]; trap?: boolean }

const ITEMS: Item[] = [
  // one document: "Want it?"
  { list: ONE, reply: 'yes', expect: 'choose:d-react' },
  { list: ONE, reply: 'sure', expect: 'choose:d-react' },
  { list: ONE, reply: 'yep go', expect: 'choose:d-react' },
  { list: ONE, reply: 'go ahead', expect: 'choose:d-react' },
  { list: ONE, reply: 'ok do it', expect: 'choose:d-react' },
  { list: ONE, reply: 'Yes please!', expect: 'choose:d-react' },
  { list: ONE, reply: "let's do it", expect: 'choose:d-react' },
  { list: ONE, reply: 'sounds good', expect: 'choose:d-react' },
  { list: ONE, reply: '👍', expect: ['choose:d-react', 'unclear'] },
  { list: ONE, reply: 'yes but about chapter 2', expect: ['choose:d-react', 'unclear'] },
  { list: ONE, reply: 'react', expect: 'choose:d-react' },
  { list: ONE, reply: '1', expect: 'choose:d-react' },
  { list: ONE, reply: '2', expect: 'unclear' },
  { list: ONE, reply: 'no', expect: 'cancel' },
  { list: ONE, reply: 'nah', expect: 'cancel' },
  { list: ONE, reply: 'cancel', expect: 'cancel' },
  { list: ONE, reply: 'no thanks', expect: 'cancel' },
  { list: ONE, reply: 'not now', expect: 'cancel' },
  { list: ONE, reply: 'never mind', expect: 'cancel' },
  { list: ONE, reply: 'maybe later', expect: ['cancel', 'unclear'] },
  { list: ONE, reply: "I don't want a quiz", expect: 'cancel' },
  { list: ONE, reply: "don't cancel", expect: ['choose:d-react', 'unclear'] },
  { list: ONE, reply: 'hello there', expect: ['unrelated', 'unclear'] },
  { list: ONE, reply: "what's in chapter 3?", expect: 'unrelated' },
  { list: ONE, reply: 'what is react?', expect: 'unrelated', trap: true },
  { list: ONE, reply: 'what does the first chapter say?', expect: 'unrelated', trap: true },
  { list: ONE, reply: 'summarize it', expect: 'unrelated', trap: true },
  { list: ONE, reply: 'explain react components to me', expect: 'unrelated', trap: true },

  // two React files: "Which document? 1. react-intro.pdf 2. react-hooks.pdf"
  { list: TWO_REACT, reply: 'yes', expect: 'unclear' },
  { list: TWO_REACT, reply: 'the second one', expect: 'choose:d-hooks' },
  { list: TWO_REACT, reply: '2', expect: 'choose:d-hooks' },
  { list: TWO_REACT, reply: 'first', expect: 'choose:d-intro' },
  { list: TWO_REACT, reply: '1st', expect: 'choose:d-intro' },
  { list: TWO_REACT, reply: 'the last one', expect: 'choose:d-hooks' },
  { list: TWO_REACT, reply: 'hooks', expect: 'choose:d-hooks' },
  { list: TWO_REACT, reply: 'the hooks one please', expect: 'choose:d-hooks' },
  { list: TWO_REACT, reply: 'react intro', expect: 'choose:d-intro' },
  { list: TWO_REACT, reply: 'react', expect: 'unclear' },
  { list: TWO_REACT, reply: 'the React document', expect: 'unclear' },
  { list: TWO_REACT, reply: 'both', expect: 'unclear' },
  { list: TWO_REACT, reply: '3', expect: 'unclear' },
  { list: TWO_REACT, reply: 'cancel', expect: 'cancel' },
  { list: TWO_REACT, reply: 'no, the second one', expect: ['choose:d-hooks', 'unclear'] },
  { list: TWO_REACT, reply: 'not the first, the second', expect: ['choose:d-hooks', 'unclear'] },
  { list: TWO_REACT, reply: 'is the second one about hooks?', expect: 'unrelated', trap: true },
  { list: TWO_REACT, reply: 'explain 2 more', expect: 'unrelated', trap: true },
  { list: TWO_REACT, reply: 'what are react hooks', expect: 'unrelated', trap: true },
  { list: TWO_REACT, reply: 'compare the two', expect: 'unrelated', trap: true },

  // three different files
  { list: THREE, reply: '3', expect: 'choose:d-hist' },
  { list: THREE, reply: 'the third', expect: 'choose:d-hist' },
  { list: THREE, reply: 'number two', expect: 'choose:d-react' },
  { list: THREE, reply: 'option 1', expect: 'choose:d-bio' },
  { list: THREE, reply: 'biology', expect: 'choose:d-bio' },
  { list: THREE, reply: 'the biology notes', expect: 'choose:d-bio' },
  { list: THREE, reply: 'ww2', expect: 'choose:d-hist' },
  { list: THREE, reply: 'the history one', expect: 'choose:d-hist' },
  { list: THREE, reply: 'quiz me on biology', expect: 'choose:d-bio' },
  { list: THREE, reply: 'sure', expect: 'unclear' },
  { list: THREE, reply: 'stop', expect: 'cancel' },
  { list: THREE, reply: 'tell me about ww2', expect: 'unrelated', trap: true },
  { list: THREE, reply: 'give me 2 examples from biology', expect: 'unrelated', trap: true },
  { list: THREE, reply: '2 examples please', expect: 'unrelated', trap: true },
  { list: THREE, reply: 'biology chapter 1 key points', expect: 'unrelated', trap: true },

  // numbers that are also in filenames
  { list: LECTURES, reply: '2', expect: 'unclear' },
  { list: LECTURES, reply: 'lecture 3', expect: ['choose:d-l3', 'unclear'] },
  { list: LECTURES, reply: 'the first one', expect: 'choose:d-l2' },
  { list: LECTURES, reply: 'the last', expect: 'choose:d-l3' },
]

// ── Grading ─────────────────────────────────────────────────────────────────
function code(reading: QuizReplyReading): string {
  return reading.action === 'choose' ? `choose:${reading.documentId}` : reading.action
}

type Grade = 'right' | 'annoying' | 'harmful'
function grade(item: Item, reading: QuizReplyReading): Grade {
  const expected = Array.isArray(item.expect) ? item.expect : [item.expect]
  if (expected.includes(code(reading))) return 'right'
  // any pick that isn't an expected one is harmful: it makes a quiz the user
  // didn't ask for (or on the wrong document) instead of what they wanted
  return reading.action === 'choose' ? 'harmful' : 'annoying'
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MARK: Record<Grade, string> = { right: chalk.green('✓'), annoying: chalk.yellow('~'), harmful: chalk.red('✗') }
const BY_COLOR = { rule: chalk.cyan, llm: chalk.magenta, fallback: chalk.red }

export async function runReplyEval(mode: 'all' | 'rules') {
  const t0 = Date.now()
  // AbortSignal.timeout() timers don't keep Node alive (CLAUDE.md §9), so a
  // script waiting only on a timed fetch could exit mid-await. This does.
  const keepAlive = setInterval(() => {}, 1000)

  pipelineStart(
    'workflow',
    `WF.4 REPLY READER EVAL — ${ITEMS.length} replies (${ITEMS.filter((i) => i.trap).length} traps), mode: ${mode === 'rules' ? 'rules only, 0 API calls' : `rules + LLM (paced ${PAUSE_MS / 1000} s)`}`,
  )

  const tally = { right: 0, annoying: 0, harmful: 0, rule: 0, llm: 0, fallback: 0, notCalled: 0, trapsToRules: 0 }
  const problems: string[] = []
  const llmMs: number[] = []
  let llmCalls = 0
  let lastList: QuizCandidate[] | null = null

  for (const item of ITEMS) {
    if (item.list !== lastList) {
      console.log(chalk.bold(`\n  Candidates: ${item.list.map((x, i) => `${i + 1}. ${x.filename}`).join('  ')}`))
      lastList = item.list
    }
    const question: QuizQuestion = { question: questionFor(item.list), candidates: item.list }
    const expected = Array.isArray(item.expect) ? item.expect.join(' | ') : item.expect
    const label = `${JSON.stringify(item.reply).padEnd(36)}${item.trap ? chalk.red(' trap') : '     '}`

    const byRules = readByRules(item.reply, item.list)
    let decision: QuizReplyDecision | null = byRules.decision
    if (decision && item.trap) tally.trapsToRules++

    if (!decision && mode === 'rules') {
      tally.notCalled++
      console.log(`  ${chalk.gray('·')} ${label} ${chalk.gray(`→ LLM, not called (${byRules.whyNot})`)}   expect ${expected}`)
      continue
    }

    if (!decision) {
      if (llmCalls > 0) await sleep(PAUSE_MS)
      const started = Date.now()
      decision = await interpretQuizReply(item.reply, question)
      llmCalls++
      // a 429 (rate limit) is the test's problem, not the reader's: wait, retry once
      if (decision.errors.some((e) => e.includes('429'))) {
        console.log(chalk.yellow(`    429 from Gemini, waiting ${RETRY_AFTER_429_MS / 1000} s and retrying once`))
        await sleep(RETRY_AFTER_429_MS)
        decision = await interpretQuizReply(item.reply, question)
        llmCalls++
      }
      llmMs.push(Date.now() - started)
    }

    tally[decision.by]++
    const g = grade(item, decision.reading)
    tally[g]++
    const extra = decision.reading.action === 'unclear' && decision.reading.matches.length < item.list.length
      ? ` (${decision.reading.matches.map((m) => m.filename).join(', ')})`
      : ''
    console.log(
      `  ${MARK[g]} ${label} ${BY_COLOR[decision.by](decision.by.padEnd(8))} ${code(decision.reading)}${extra}` +
        `${g === 'right' ? '' : `   expect ${expected}`}  ${chalk.gray(decision.why)}`,
    )
    for (const e of decision.errors) console.log(chalk.red(`      error: ${e.split('\n')[0]}`))
    if (g !== 'right') problems.push(`${g}: ${JSON.stringify(item.reply)} → ${code(decision.reading)} (expect ${expected}, by ${decision.by})`)
  }

  // What WF.5 will send for an unclear reply, so the wording can be checked by eye
  console.log(chalk.bold('\n  "Ask again" texts (askAgainText):'))
  for (const [question, matches] of [
    [{ question: questionFor(ONE), candidates: ONE }, ONE],
    [{ question: questionFor(THREE), candidates: THREE }, THREE],
    [{ question: questionFor(LECTURES), candidates: LECTURES }, [LECTURES[1], LECTURES[0]]],
  ] as [QuizQuestion, QuizCandidate[]][]) {
    console.log(chalk.gray(`    ${askAgainText(question, matches).replace(/\n+/g, ' ⏎ ')}`))
  }

  clearInterval(keepAlive)
  const graded = tally.right + tally.annoying + tally.harmful
  console.log(chalk.bold('\n  Summary'))
  console.log(`    graded ${graded}: ${chalk.green(`${tally.right} right`)}, ${chalk.yellow(`${tally.annoying} annoying`)}, ${tally.harmful ? chalk.red(`${tally.harmful} HARMFUL`) : chalk.green('0 harmful')}`)
  console.log(`    decided by: rules ${tally.rule}, LLM ${tally.llm}, fallback ${tally.fallback}${mode === 'rules' ? `, LLM not called ${tally.notCalled}` : ''}`)
  console.log(`    traps taken by the rules: ${tally.trapsToRules ? chalk.red(String(tally.trapsToRules)) : chalk.green('0')} (fix 3: must be 0)`)
  if (llmMs.length) {
    const sorted = [...llmMs].sort((a, b) => a - b)
    console.log(`    Gemini calls: ${llmCalls}; time per reply median ${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(1)} s, max ${(sorted[sorted.length - 1] / 1000).toFixed(1)} s`)
  }
  for (const p of problems) console.log(`    ${p.startsWith('harmful') ? chalk.red(p) : chalk.yellow(p)}`)
  pipelineEnd('workflow', Date.now() - t0, 'Eval time')
}
