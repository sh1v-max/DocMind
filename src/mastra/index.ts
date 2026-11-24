import { Mastra } from '@mastra/core/mastra'
import { MastraCompositeStore } from '@mastra/core/storage'
import { WorkflowsPG } from '@mastra/pg'
import { pool } from '../db/client'
import { quizWorkflow } from './workflows/quiz.workflow'
import { workflowDetail } from '../utils/pipelineLogger'
import { summarizeError } from '../utils/errors'

// WF.3 — the one Mastra instance of the app (suspend-resume.md §4.3).
//
// Boundary rule (rule 2): only src/mastra/** and quizWorkflow.service.ts import
// Mastra. Everything else calls the service, which answers in DocMind shapes.
//
// What's switched on, and what isn't:
//   - storage: ONLY the workflows domain (no memory/agent/eval tables), in the
//     Postgres schema "mastra" (D3), sharing the app's ONE pg Pool (WF.0
//     exported it), so Mastra opens no extra Neon connections.
//   - logger: false (D7). pipelineLogger is the project's log; Mastra's errors
//     still reach us as thrown errors / failed results.
//   - recovery 'off' (D5). WF.1 showed it does nothing in an embedded Mastra
//     anyway; it stays written down as intent.
//   - telemetry: off through MASTRA_TELEMETRY_DISABLED=1 in the env (rule 14).

function buildMastra() {
  const workflowsStore = new WorkflowsPG({ pool, schemaName: 'mastra' })
  const storage = new MastraCompositeStore({ id: 'docmind', domains: { workflows: workflowsStore } })
  const mastra = new Mastra({
    storage,
    workflows: { quizWorkflow },
    logger: false,
    recovery: { workflows: 'off' },
  })
  return { mastra, storage, workflowsStore }
}

type BuiltMastra = ReturnType<typeof buildMastra>

// Built on FIRST USE, not at boot (fix 5, rule 19), the same way
// queue/connection.ts opens Redis on first use: nothing Mastra-related runs
// when the API starts, so a Mastra or storage problem can never stop the API
// from booting. The first quiz pays the setup (WF.1: storage.init() was
// 3–8 s from the laptop, 12 queries; 0 ms the second time).
//
// A SINGLETON: the promise is kept, so every later call gets the same ready
// instance, and two requests arriving together during the first setup share
// one init instead of running two. If setup FAILS, the promise is dropped, so
// the next quiz tries again instead of being stuck with a failure forever.
let ready: Promise<BuiltMastra> | null = null

export function getMastra(): Promise<BuiltMastra> {
  if (!ready) {
    ready = (async () => {
      const started = Date.now()
      const built = buildMastra()
      // init() creates the schema / tables / indexes if they're missing.
      await built.storage.init()
      workflowDetail(`Mastra ready (storage.init ${Date.now() - started} ms)`)
      pruneOldRows(built.workflowsStore)
      return built
    })().catch((err) => {
      ready = null
      throw err
    })
  }
  return ready
}

// Returned INSIDE an object on purpose. A Mastra Workflow has a `.then()`
// method (the one that chains steps: createWorkflow(...).then(step)). If an
// async function returned the workflow itself, JavaScript would treat it as a
// promise-like "thenable" and CALL that .then() to unwrap it. TypeScript
// refused to compile it (TS1058), which is how this was found.
export async function getQuizWorkflow() {
  return { workflow: (await getMastra()).mastra.getWorkflow('quizWorkflow') }
}

// Housekeeping, once per process (fire and forget, never awaited, never throws):
//   - runOwnership: Mastra writes one small "lease" row per run in
//     mastra_workflow_run_owners, and deleteWorkflowRunById does NOT remove it
//     (found in WF.1). prune() is Mastra's own way to clear them.
//   - workflowSnapshot: every run's snapshot is deleted when the run ends
//     (fix 4, D8). This is only the safety net for one whose delete failed
//     (a crash at the wrong moment). Nothing legitimate is a day old: a
//     waiting run expires after 30 min, a running one is stale after 3 min.
// Render restarts the process on every deploy and after ~15 min idle, so
// "once per process" runs often enough. The first prune also makes Mastra
// create a small index on each table's age column (its own tables).
function pruneOldRows(workflowsStore: WorkflowsPG) {
  workflowsStore
    .prune({ workflowSnapshot: { maxAge: '1d' }, runOwnership: { maxAge: '1d' } }, { maxRows: 1000 })
    .then((results) => {
      const deleted = results.map((r) => `${r.table} ${r.deleted}`).join(', ')
      workflowDetail(`pruned rows older than 1 day: ${deleted || 'nothing'}`)
    })
    .catch((err) => {
      workflowDetail('prune of old Mastra rows failed (harmless, retried next start)')
      console.error(summarizeError(err))
    })
}
