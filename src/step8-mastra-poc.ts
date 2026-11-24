import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { Mastra } from '@mastra/core/mastra'
import { MastraCompositeStore } from '@mastra/core/storage'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { WorkflowsPG } from '@mastra/pg'
import { pool } from './db/client'

// WF.1 — the proof of concept, and the GATE for Phase 8 (suspend-resume.md §6).
// Nothing in the chat changes until every mode below behaves as expected.
//
// A toy workflow, "poc-approval", with two steps:
//
//   ask ──(suspend: "Approve <label>?")──►  ...wait, maybe for days...  ──► finish
//        ▲ resumed with { approved: true }  → finish runs → status 'success'
//        ▲ resumed with { approved: false } → bail()      → status 'success' too (!)
//
// No DocMind code, no Gemini, no users. It only proves how Mastra's
// suspend/resume behaves with REAL Postgres storage (schema "mastra" in Neon),
// across separate processes — exactly the situation of two HTTP requests on
// Render with a restart in between.
//
// Run (each line is a separate process on purpose: "state survived a restart"
// only means something if the process really ended):
//   npm run step8 start [label]        start a run → it pauses at "ask" → process exits
//   npm run step8 inspect <runId>      the run as Mastra reports it + the raw snapshot row
//   npm run step8 resume <runId> [no]  a NEW process continues the run (yes by default)
//   npm run step8 race <runId>         two resume() calls at the same moment
//   npm run step8 again <runId>        resume a run that already finished
//   npm run step8 cancel [runId]       cancel a paused run, then try to resume it
//   npm run step8 bail                 start + answer "no" → bail() → see the status
//   npm run step8 throw                a step that throws → see the status
//   npm run step8 crash                kill a process in the middle of a step, then
//                                      see what recovery 'off' / 'auto' do
//   npm run step8 cleanup              delete every poc-approval run (0 rows left)
//
// Safe-ish: it writes ONLY to the "mastra" schema (Mastra's own tables), never
// to users/documents/chunks/chat_messages. `cleanup` removes everything it made.
// It does talk to the production Neon database (local .env = production).

// ── Small helpers ───────────────────────────────────────────────────────────
const t0 = Date.now()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (text: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}`)
const json = (value: unknown) => JSON.stringify(value)

// WF.1 — the counter that proves rule 8b. Every time the "ask" step's execute()
// starts, this goes up by one and gets printed. In `start` it prints #1 (then
// the step pauses). In `resume`, a brand-new process, it prints #1 AGAIN: the
// paused step doesn't continue from the line after suspend(), it runs again
// from its FIRST line, this time with resumeData filled in. That's why the
// real quiz step must do nothing expensive before its `if (!resumeData)`.
let askExecuteCalls = 0

// The slow step used by `crash`. Long enough to kill the process in the middle.
const SLOW_STEP_MS = 20_000

// ── The steps ───────────────────────────────────────────────────────────────
// A step is a function with typed edges: what comes in (inputSchema), what
// goes out (outputSchema), what it says when it pauses (suspendSchema) and
// what it expects back when someone resumes it (resumeSchema). Mastra checks
// these with Zod — the same Zod 4 the app already uses.
const PocInput = z.object({
  label: z.string(),
  // 'normal' pauses and waits; 'throw' fails on purpose; 'slow' works for 20 s (crash test)
  behaviour: z.enum(['normal', 'throw', 'slow']),
})
const Approved = z.object({ label: z.string(), approved: z.boolean() })
const PocOutput = z.object({ outcome: z.string(), label: z.string() })

const askStep = createStep({
  id: 'ask',
  inputSchema: PocInput,
  outputSchema: Approved,
  suspendSchema: z.object({ question: z.string() }),
  resumeSchema: z.object({ approved: z.boolean() }),
  execute: async ({ inputData, resumeData, suspend, bail }) => {
    askExecuteCalls++
    log(`  ask.execute() started — call #${askExecuteCalls} in THIS process, resumeData = ${json(resumeData)}`)

    if (inputData.behaviour === 'throw') {
      throw new Error('WF.1 — this step throws on purpose')
    }

    if (inputData.behaviour === 'slow') {
      log(`  slow step: working for ${SLOW_STEP_MS / 1000} s (pretend this is a Gemini call)...`)
      await sleep(SLOW_STEP_MS)
      log('  slow step: finished')
      return { label: inputData.label, approved: true }
    }

    // The pattern every pausing step uses (rule 8b): FIRST line decides.
    // No resumeData = we're here for the first time → pause and ask.
    // suspend() saves the snapshot to Postgres and ends this execute() call;
    // run.start() then returns with status 'suspended'.
    if (!resumeData) {
      return await suspend({ question: `Approve "${inputData.label}"?` })
    }

    // Resumed with "no": bail() ends the WHOLE run early, skipping "finish".
    // Mastra reports a bailed run as status 'success' with this payload as the
    // result — so the real workflow must read an `outcome` field, never just
    // the status (D9).
    if (!resumeData.approved) {
      return bail({ outcome: 'declined', label: inputData.label })
    }

    return { label: inputData.label, approved: true }
  },
})

const finishStep = createStep({
  id: 'finish',
  inputSchema: Approved,
  outputSchema: PocOutput,
  execute: async ({ inputData }) => {
    log(`  finish.execute() ran for "${inputData.label}"`)
    return { outcome: 'approved', label: inputData.label }
  },
})

// .then() chains steps; .commit() freezes the graph. The workflow's id is the
// `workflow_name` column in Mastra's snapshot table.
const pocWorkflow = createWorkflow({
  id: 'poc-approval',
  inputSchema: PocInput,
  outputSchema: PocOutput,
  options: { validateInputs: true },
})
  .then(askStep)
  .then(finishStep)
  .commit()

// ── The Mastra instance (the same shape the real app will use, §4.3) ────────
// - MastraCompositeStore with ONLY the workflows domain: no memory/agent/eval tables.
// - WorkflowsPG shares the app's pg Pool (WF.0 exported it) → no extra connections.
// - schemaName 'mastra' keeps Mastra's tables out of `public` (D3).
// - logger: false (D7). recovery: 'off' unless a test asks for 'auto' (D5).
function buildMastra(recovery: 'off' | 'auto' = 'off') {
  const storage = new MastraCompositeStore({
    id: 'docmind-poc',
    domains: { workflows: new WorkflowsPG({ pool, schemaName: 'mastra' }) },
  })
  const mastra = new Mastra({
    storage,
    workflows: { pocWorkflow },
    logger: false,
    recovery: { workflows: recovery },
  })
  return { mastra, storage }
}

// init() creates the schema/tables/indexes if they're missing (first run only).
async function setup(recovery: 'off' | 'auto' = 'off') {
  const { mastra, storage } = buildMastra(recovery)
  const started = Date.now()
  await storage.init()
  log(`storage.init() done in ${Date.now() - started} ms (recovery: '${recovery}')`)
  return { mastra, workflow: mastra.getWorkflow('pocWorkflow') }
}

// ── Raw SQL helpers ─────────────────────────────────────────────────────────
// A learning script peeking at Mastra's own table, to SEE what it stored.
// (The app itself never does this: rule "only repositories touch SQL", and
// Mastra's tables are Mastra's business.)
async function snapshotRow(runId: string) {
  const { rows } = await pool.query(
    `SELECT workflow_name, run_id, "resourceId", snapshot, "createdAt", "updatedAt",
            octet_length(snapshot::text) AS bytes
       FROM mastra.mastra_workflow_snapshot WHERE run_id = $1`,
    [runId],
  )
  return rows[0] ?? null
}

async function storedStatus(runId: string): Promise<string> {
  const row = await snapshotRow(runId)
  return row ? String(row.snapshot?.status) : '(no row)'
}

async function listMastraTables() {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'mastra' ORDER BY table_name`,
  )
  return rows.map((r) => r.table_name as string)
}

// Mastra errors carry an `id` (e.g. WORKFLOW_RESUME_ALREADY_CLAIMED); print it.
function describeError(err: unknown) {
  const e = err as { id?: string; message?: string }
  return `${e?.id ? `[${e.id}] ` : ''}${e?.message ?? String(err)}`
}

function printResult(label: string, result: { status: string; [key: string]: unknown }) {
  log(`${label}: status = '${result.status}'`)
  if ('suspendPayload' in result) log(`  suspendPayload = ${json(result.suspendPayload)}`)
  if ('suspended' in result) log(`  suspended (step path) = ${json(result.suspended)}`)
  if ('result' in result) log(`  result = ${json(result.result)}`)
  if ('error' in result) log(`  error = ${describeError(result.error)}`)
}

// ── Modes ───────────────────────────────────────────────────────────────────
type Workflow = Awaited<ReturnType<typeof setup>>['workflow']

async function startRun(workflow: Workflow, label: string, behaviour: z.infer<typeof PocInput>['behaviour']) {
  // We pick the runId ourselves (randomUUID), the same way the real app will,
  // so the pointer row can be written BEFORE start() (§4.6, D10).
  const runId = randomUUID()
  const run = await workflow.createRun({ runId, resourceId: 'wf1-poc' })
  log(`run ${runId}: start()`)
  const result = await run.start({ inputData: { label, behaviour } })
  return { runId, result }
}

async function modeStart(label: string) {
  const { workflow } = await setup()
  const { runId, result } = await startRun(workflow, label, 'normal')
  printResult('start() returned', result)

  const row = await snapshotRow(runId)
  log(`row in mastra.mastra_workflow_snapshot: ${row ? `yes (status '${row.snapshot.status}', ${row.bytes} bytes)` : 'NO'}`)
  log(`tables in schema "mastra": ${(await listMastraTables()).join(', ')}`)
  log(`next: npm run step8 inspect ${runId}`)
  log(`      npm run step8 resume ${runId}`)
}

async function modeInspect(runId: string) {
  const { workflow } = await setup()

  // 1. What Mastra's API says.
  const state = await workflow.getWorkflowRunById(runId)
  if (!state) {
    log('getWorkflowRunById → null (no such run)')
    return
  }
  log(`getWorkflowRunById → status '${state.status}'`)
  log(`  steps: ${json(state.steps)}`)

  // 2. The raw row: this is what survives a restart.
  const row = await snapshotRow(runId)
  if (!row) return
  const s = row.snapshot
  log(`raw row: workflow_name '${row.workflow_name}', resourceId '${row.resourceId}', ${row.bytes} bytes`)
  log(`  snapshot keys: ${Object.keys(s).join(', ')}`)
  log(`  snapshot.status = ${json(s.status)}`)
  log(`  snapshot.suspendedPaths = ${json(s.suspendedPaths)}`)
  log(`  snapshot.context.input = ${json(s.context?.input)}`)
  for (const [stepId, stepState] of Object.entries(s.context ?? {})) {
    if (stepId === 'input') continue
    const st = stepState as Record<string, unknown>
    log(`  snapshot.context.${stepId} = ${json({
      status: st.status,
      payload: st.payload,
      suspendPayload: st.suspendPayload,
      resumePayload: st.resumePayload,
      output: st.output,
    })}`)
  }
  log(`  snapshot.result = ${json(s.result)}`)
}

async function modeResume(runId: string, answer: string) {
  const { workflow } = await setup()
  log(`stored status before resume: '${await storedStatus(runId)}'`)

  // A fresh process knows NOTHING about the run except its id. createRun({ runId })
  // doesn't make a new run here: it gives us a handle on the stored one.
  const run = await workflow.createRun({ runId })
  const approved = answer !== 'no'
  log(`run ${runId}: resume({ approved: ${approved} })`)
  const result = await run.resume({ step: 'ask', resumeData: { approved } })
  printResult('resume() returned', result)
  log(`stored status after: '${await storedStatus(runId)}'`)
}

async function modeRace(runId: string) {
  const { workflow } = await setup()
  log(`stored status before: '${await storedStatus(runId)}'`)

  // Two handles, like two HTTP requests (a button click + a typed "yes")
  // arriving at the same moment. Both call resume() without waiting.
  const runA = await workflow.createRun({ runId })
  const runB = await workflow.createRun({ runId })
  const [a, b] = await Promise.allSettled([
    runA.resume({ step: 'ask', resumeData: { approved: true } }),
    runB.resume({ step: 'ask', resumeData: { approved: true } }),
  ])
  for (const [name, outcome] of [['A', a], ['B', b]] as const) {
    if (outcome.status === 'fulfilled') log(`resume ${name}: fulfilled, status '${outcome.value.status}'`)
    else log(`resume ${name}: REJECTED, ${describeError(outcome.reason)}`)
  }
  log(`ask.execute() ran ${askExecuteCalls} time(s) in this process (1 = only the winner ran it)`)
  log(`stored status after: '${await storedStatus(runId)}'`)
}

async function modeAgain(runId: string) {
  const { workflow } = await setup()
  log(`stored status before: '${await storedStatus(runId)}'`)
  const run = await workflow.createRun({ runId })
  try {
    const result = await run.resume({ step: 'ask', resumeData: { approved: true } })
    printResult('resume() on a finished run RETURNED (no throw)', result)
  } catch (err) {
    log(`resume() on a finished run THREW: ${describeError(err)}`)
  }
  log(`ask.execute() ran ${askExecuteCalls} time(s) (0 = nothing re-ran)`)
  log(`stored status after: '${await storedStatus(runId)}'`)
}

async function modeCancel(existingRunId?: string) {
  const { workflow } = await setup()
  let runId = existingRunId
  if (!runId) {
    const started = await startRun(workflow, 'cancel me', 'normal')
    runId = started.runId
    printResult('start() returned', started.result)
  }
  const run = await workflow.createRun({ runId })
  await run.cancel()
  log(`cancel() done → stored status '${await storedStatus(runId)}'`)

  const again = await workflow.createRun({ runId })
  try {
    const result = await again.resume({ step: 'ask', resumeData: { approved: true } })
    printResult('resume() after cancel RETURNED (no throw)', result)
  } catch (err) {
    log(`resume() after cancel THREW: ${describeError(err)}`)
  }
  log(`stored status after: '${await storedStatus(runId)}'`)
}

async function modeBail() {
  const { workflow } = await setup()
  const { runId, result } = await startRun(workflow, 'bail me', 'normal')
  printResult('start() returned', result)
  const run = await workflow.createRun({ runId })
  log(`run ${runId}: resume({ approved: false }) → the step calls bail()`)
  const resumed = await run.resume({ step: 'ask', resumeData: { approved: false } })
  printResult('resume() returned', resumed)
  log(`stored status: '${await storedStatus(runId)}' (finish never ran: no "finish.execute()" line above)`)
}

async function modeThrow() {
  const { workflow } = await setup()
  const { runId, result } = await startRun(workflow, 'throw', 'throw')
  printResult('start() returned (it did NOT throw to us)', result)
  log(`stored status: '${await storedStatus(runId)}'`)
}

// ── crash: what happens to a run whose process dies mid-step ────────────────
// The parent spawns a child process that starts a 'slow' run, kills it
// (like Render killing the server mid-request), then looks at the run with a
// fresh Mastra instance: recovery 'off', then 'auto', then calling the
// recovery sweep by hand (what Mastra's own server would do at boot).
async function modeCrashChild() {
  const { workflow } = await setup()
  const runId = randomUUID()
  const run = await workflow.createRun({ runId, resourceId: 'wf1-poc' })
  console.log(`RUN_ID=${runId}`) // the parent reads this line
  await run.start({ inputData: { label: 'crash me', behaviour: 'slow' } })
  log('child: the run finished (it should have been killed before this!)')
}

async function modeCrash() {
  log('spawning a child process that starts a slow run...')
  const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', __filename, 'crash-child'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  })
  const runId = await new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) console.log(`    child | ${line.trim()}`)
        const m = line.match(/RUN_ID=([\w-]+)/)
        if (m) resolve(m[1])
      }
    })
    child.on('exit', (code) => reject(new Error(`child exited early (code ${code})`)))
  })
  await sleep(4000) // let it get into the slow step
  log(`killing the child mid-step (run ${runId})`)
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  log('child is dead')

  log(`stored status right after the kill: '${await storedStatus(runId)}'`)

  // 1. A new process with recovery 'off' (our plan, D5).
  const off = await setup('off')
  await sleep(5000)
  log(`after a 'off' boot + 5 s: stored status '${await storedStatus(runId)}'`)

  // 2. A new instance with recovery 'auto' (Mastra's default).
  const auto = await setup('auto')
  await sleep(5000)
  log(`after an 'auto' boot + 5 s: stored status '${await storedStatus(runId)}'`)
  const active = await auto.mastra.listActiveWorkflowRuns()
  log(`mastra.listActiveWorkflowRuns() sees ${active.total} run(s): ${json(active.runs.map((r) => r.runId))}`)

  // 3. The recovery sweep by hand: this is what Mastra's server/deployer
  //    calls at boot when recovery is 'auto'. Our Express app would only run
  //    it if WE called it.
  log('calling mastra.restartAllActiveWorkflowRuns() by hand...')
  const before = askExecuteCalls
  await auto.mastra.restartAllActiveWorkflowRuns()
  log(`restartAllActiveWorkflowRuns() returned; ask.execute() ran ${askExecuteCalls - before} time(s) here`)
  log(`stored status now: '${await storedStatus(runId)}'`)
  void off
}

async function modeCleanup() {
  const { workflow } = await setup()
  const { runs, total } = await workflow.listWorkflowRuns()
  log(`poc-approval runs in storage: ${total}`)
  const ids = runs.map((r) => r.runId)
  for (const id of ids) await workflow.deleteWorkflowRunById(id)

  const snap = await pool.query(
    `SELECT count(*)::int AS n FROM mastra.mastra_workflow_snapshot WHERE workflow_name = 'poc-approval'`,
  )
  log(`deleted ${ids.length}; snapshot rows left for poc-approval: ${snap.rows[0].n}`)
  // WF.1 finding: deleteWorkflowRunById removes the SNAPSHOT row only. Every
  // run also gets a row in mastra_workflow_run_owners (who is executing it,
  // a "lease"), and that one stays behind. Mastra's own way to clear them is
  // age-based: workflowsStore.prune({ runOwnership: { maxAge: '1d' } }). This
  // learning script deletes exactly its own ids instead, so it can never touch
  // anything else. (How the real app handles it is decided in WF.3.)
  if (ids.length) {
    const owners = await pool.query(
      `DELETE FROM mastra.mastra_workflow_run_owners WHERE "runId" = ANY($1)`,
      [ids],
    )
    log(`deleted ${owners.rowCount} run-owner row(s) for those runs`)
  }
  const left = await pool.query(
    `SELECT (SELECT count(*) FROM mastra.mastra_workflow_snapshot)::int AS snapshots,
            (SELECT count(*) FROM mastra.mastra_workflow_run_owners)::int AS owners`,
  )
  log(`rows left in schema "mastra" (all workflows): ${left.rows[0].snapshots} snapshot(s), ${left.rows[0].owners} owner row(s)`)
}

// ── Entry point ─────────────────────────────────────────────────────────────
async function main() {
  const [mode, arg1, arg2] = process.argv.slice(2)
  const needId = (id?: string) => {
    if (!id) throw new Error(`usage: npm run step8 ${mode} <runId>`)
    return id
  }
  switch (mode) {
    case 'start': return modeStart(arg1 ?? 'quiz on notes.pdf')
    case 'inspect': return modeInspect(needId(arg1))
    case 'resume': return modeResume(needId(arg1), arg2 ?? 'yes')
    case 'race': return modeRace(needId(arg1))
    case 'again': return modeAgain(needId(arg1))
    case 'cancel': return modeCancel(arg1)
    case 'bail': return modeBail()
    case 'throw': return modeThrow()
    case 'crash': return modeCrash()
    case 'crash-child': return modeCrashChild()
    case 'cleanup': return modeCleanup()
    default:
      console.log('modes: start [label] | inspect <runId> | resume <runId> [no] | race <runId> | again <runId> | cancel [runId] | bail | throw | crash | cleanup')
  }
}

main()
  .catch((err) => {
    log(`FAILED: ${describeError(err)}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end().catch(() => {})
    // Mastra may keep timers alive (recovery re-checks etc.); a learning
    // script just leaves.
    process.exit()
  })
