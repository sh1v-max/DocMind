import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { quizWorkflowRuns } from '../db/schema'
import { QUIZ_RUN_STALE_MS, QUIZ_RUN_TTL_MS } from '../config'

// WF.2 — the pointer rows of the quiz workflow (suspend-resume.md §4.4).
//
// Same rules as every other repository (CLAUDE.md §6):
//   - every function that reads, changes or deletes a row takes a REQUIRED
//     userId, and filters on it in the SQL. Another user's runId or sessionId
//     simply finds nothing (the caller answers 404, never 403).
//   - nothing else in the app touches this table directly.
//
// The life of one row:
//
//   "quiz me"   createActiveRun()   INSERT 'running'      ← BEFORE Mastra's start()
//   run pauses  markWaiting()       'running' → 'waiting' (expires in 30 min)
//   "yes"       claimWaitingRun()   'waiting' → 'running' (only ONE caller wins)
//   run ends    markDone()          → 'done'
//
// "Active" means 'waiting' or 'running'. The partial unique index in
// schema.ts allows at most one active row per (user, session).
//
// Time: every "now" below is Postgres's now(), never the Node clock. The
// expiry is written with the database's clock and compared with the database's
// clock, so a laptop or server whose clock drifts can't expire a run early.

export type QuizRunStatus = 'waiting' | 'running' | 'done'

// What the chat needs to know about the active run in a conversation.
// `expired` / `stale` are computed by Postgres in the same query, so the
// caller doesn't do date maths:
//   expired = waiting, and its 30 minutes are up  → treat the next message as new
//   stale   = running for more than 3 min         → the process died mid-step
export interface ActiveQuizRun {
  runId: string
  sessionId: string
  status: Exclude<QuizRunStatus, 'done'>
  createdAt: Date
  updatedAt: Date
  expiresAt: Date | null
  expired: boolean
  stale: boolean
}

// "active" as a SQL condition, written once
const isActive = inArray(quizWorkflowRuns.status, ['waiting', 'running'])

// Start of a run. Returns false when this conversation already has an active
// quiz (waiting or running). That "no" comes from the unique index, not from a
// "SELECT first, then INSERT" check: two "quiz me" messages arriving at the
// same moment would both pass a SELECT, but only one INSERT can succeed.
//
// ON CONFLICT DO NOTHING (with no column list) skips the row on ANY unique
// violation, including the partial index, instead of throwing; RETURNING then
// gives back 0 rows. So the caller gets a clean boolean, not a 23505 to parse.
export async function createActiveRun(runId: string, userId: string, sessionId: string): Promise<boolean> {
  const inserted = await db
    .insert(quizWorkflowRuns)
    .values({ runId, userId, sessionId, status: 'running' })
    .onConflictDoNothing()
    .returning({ runId: quizWorkflowRuns.runId })
  return inserted.length > 0
}
// equivalent sql query:
// INSERT INTO quiz_workflow_runs (run_id, user_id, session_id, status) VALUES ($1, $2, $3, 'running')
// ON CONFLICT DO NOTHING RETURNING run_id

// "Is a quiz active in this chat?" — read on every chat message (WF.5), before
// the embedding, so it must stay one small indexed query (the unique index on
// (user_id, session_id) covers it).
export async function findActiveRun(
  sessionId: string,
  userId: string,
  staleMs: number = QUIZ_RUN_STALE_MS,
): Promise<ActiveQuizRun | null> {
  const [row] = await db
    .select({
      runId: quizWorkflowRuns.runId,
      sessionId: quizWorkflowRuns.sessionId,
      status: quizWorkflowRuns.status,
      createdAt: quizWorkflowRuns.createdAt,
      updatedAt: quizWorkflowRuns.updatedAt,
      expiresAt: quizWorkflowRuns.expiresAt,
      expired: sql<boolean>`(${quizWorkflowRuns.status} = 'waiting' AND ${quizWorkflowRuns.expiresAt} <= now())`,
      stale: sql<boolean>`(${quizWorkflowRuns.status} = 'running' AND ${quizWorkflowRuns.updatedAt} < now() - ${staleMs}::float8 * interval '1 millisecond')`,
    })
    .from(quizWorkflowRuns)
    .where(and(eq(quizWorkflowRuns.sessionId, sessionId), eq(quizWorkflowRuns.userId, userId), isActive))
    .limit(1)
  // The column is plain TEXT; only this file writes it, and the WHERE above
  // only lets 'waiting' / 'running' through, so the cast is safe.
  return row ? { ...row, status: row.status as ActiveQuizRun['status'] } : null
}
// equivalent sql query:
// SELECT run_id, session_id, status, created_at, updated_at, expires_at,
//        (status = 'waiting' AND expires_at <= now()) AS expired,
//        (status = 'running' AND updated_at < now() - $3::float8 * interval '1 millisecond') AS stale
// FROM quiz_workflow_runs
// WHERE session_id = $1 AND user_id = $2 AND status IN ('waiting', 'running') LIMIT 1

// One run by id, any status — for POST /quiz-runs/:runId/resume (WF.6), which
// must tell "not yours / doesn't exist" (404) from "yours, but no longer
// waiting" (409). claimWaitingRun alone returns null for both.
export async function findRunForUser(
  runId: string,
  userId: string,
): Promise<{ runId: string; sessionId: string; status: QuizRunStatus } | null> {
  const [row] = await db
    .select({ runId: quizWorkflowRuns.runId, sessionId: quizWorkflowRuns.sessionId, status: quizWorkflowRuns.status })
    .from(quizWorkflowRuns)
    .where(and(eq(quizWorkflowRuns.runId, runId), eq(quizWorkflowRuns.userId, userId)))
    .limit(1)
  return row ? { ...row, status: row.status as QuizRunStatus } : null
}
// equivalent sql query:
// SELECT run_id, session_id, status FROM quiz_workflow_runs WHERE run_id = $1 AND user_id = $2 LIMIT 1

// The run paused (Mastra's start() came back 'suspended'): it now waits for
// the user, for at most ttlMs. Only a 'running' row can move to 'waiting';
// returns false if the row is gone or was already closed (e.g. the user
// deleted the chat while the run was starting).
export async function markWaiting(runId: string, userId: string, ttlMs: number = QUIZ_RUN_TTL_MS): Promise<boolean> {
  const updated = await db
    .update(quizWorkflowRuns)
    .set({
      status: 'waiting',
      expiresAt: sql`now() + ${ttlMs}::float8 * interval '1 millisecond'`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(quizWorkflowRuns.runId, runId), eq(quizWorkflowRuns.userId, userId), eq(quizWorkflowRuns.status, 'running')))
    .returning({ runId: quizWorkflowRuns.runId })
  return updated.length > 0
}
// equivalent sql query:
// UPDATE quiz_workflow_runs SET status = 'waiting', expires_at = now() + $3::float8 * interval '1 millisecond', updated_at = now()
// WHERE run_id = $1 AND user_id = $2 AND status = 'running' RETURNING run_id

// THE CLAIM (fix 2, rule 7). A typed "yes" and a button click can arrive at
// the same moment; both call this, and exactly one gets the row back.
//
// Why only one: Postgres locks the row while the first UPDATE changes it. The
// second UPDATE waits for that lock, then re-checks its WHERE against the NEW
// row — status is now 'running', so it matches nothing and returns 0 rows.
// No "SELECT, then decide, then UPDATE" gap for the second request to slip
// through. The loser never calls Mastra.
//
// An expired offer can't be claimed either (it's answered like "no longer
// waiting"). A NULL expires_at on a waiting row never happens through this
// file, but it's treated as "not expired" rather than unclaimable.
export async function claimWaitingRun(runId: string, userId: string): Promise<{ sessionId: string } | null> {
  const [claimed] = await db
    .update(quizWorkflowRuns)
    .set({ status: 'running', expiresAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(quizWorkflowRuns.runId, runId),
        eq(quizWorkflowRuns.userId, userId),
        eq(quizWorkflowRuns.status, 'waiting'),
        or(isNull(quizWorkflowRuns.expiresAt), sql`${quizWorkflowRuns.expiresAt} > now()`),
      ),
    )
    .returning({ sessionId: quizWorkflowRuns.sessionId })
  return claimed ?? null
}
// equivalent sql query:
// UPDATE quiz_workflow_runs SET status = 'running', expires_at = NULL, updated_at = now()
// WHERE run_id = $1 AND user_id = $2 AND status = 'waiting' AND (expires_at IS NULL OR expires_at > now())
// RETURNING session_id

// The run is over: quiz sent, cancelled, failed, expired, superseded or found
// stale. 'done' rows are kept (tiny, and handy when reading logs); they no
// longer count for the unique index, so the chat can start a new quiz.
// Returns false if the row wasn't the caller's (or doesn't exist).
export async function markDone(runId: string, userId: string): Promise<boolean> {
  const updated = await db
    .update(quizWorkflowRuns)
    .set({ status: 'done', expiresAt: null, updatedAt: sql`now()` })
    .where(and(eq(quizWorkflowRuns.runId, runId), eq(quizWorkflowRuns.userId, userId)))
    .returning({ runId: quizWorkflowRuns.runId })
  return updated.length > 0
}
// equivalent sql query:
// UPDATE quiz_workflow_runs SET status = 'done', expires_at = NULL, updated_at = now()
// WHERE run_id = $1 AND user_id = $2 RETURNING run_id

// Every active run of one user, newest first — for DELETE /documents/:id
// (fix 4): a waiting run's candidate list may include the deleted document,
// and the pointer row has no document id, so all of the user's active runs
// are cancelled. The caller cancels each in Mastra, then marks it done.
export async function listActiveRunsForUser(userId: string): Promise<{ runId: string; sessionId: string; status: QuizRunStatus }[]> {
  const rows = await db
    .select({ runId: quizWorkflowRuns.runId, sessionId: quizWorkflowRuns.sessionId, status: quizWorkflowRuns.status })
    .from(quizWorkflowRuns)
    .where(and(eq(quizWorkflowRuns.userId, userId), isActive))
    .orderBy(desc(quizWorkflowRuns.createdAt))
  return rows.map((row) => ({ ...row, status: row.status as QuizRunStatus }))
}
// equivalent sql query:
// SELECT run_id, session_id, status FROM quiz_workflow_runs
// WHERE user_id = $1 AND status IN ('waiting', 'running') ORDER BY created_at DESC

// DELETE /sessions/:id (fix 4): the chat is gone, so are its pointer rows
// (active and done). Returns what was deleted, so the caller can cancel the
// runs that were still active and delete their Mastra snapshots.
export async function deleteRunsForSession(
  sessionId: string,
  userId: string,
): Promise<{ runId: string; status: QuizRunStatus }[]> {
  const deleted = await db
    .delete(quizWorkflowRuns)
    .where(and(eq(quizWorkflowRuns.sessionId, sessionId), eq(quizWorkflowRuns.userId, userId)))
    .returning({ runId: quizWorkflowRuns.runId, status: quizWorkflowRuns.status })
  return deleted.map((row) => ({ ...row, status: row.status as QuizRunStatus }))
}
// equivalent sql query:
// DELETE FROM quiz_workflow_runs WHERE session_id = $1 AND user_id = $2 RETURNING run_id, status
