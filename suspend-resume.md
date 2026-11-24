# Suspend/Resume Plan: a durable quiz workflow on Mastra (Phase 8)

**Status:** 📝 **plan only, nothing built** (written 2026-11-07, facts re-checked 2026-11-10, **revised 2026-11-24** after a review against the code: 5 fixes + 1 simplification and a redesigned Phase 8b, listed in §0.1). No package installed, no code or schema changed. This is Phase 8 of the roadmap (topic [11-workflows-suspend-resume](topics/11-workflows-suspend-resume)). Reading: the topic's [README.md](topics/11-workflows-suspend-resume/README.md) (the short version), then [More_on_Workflows.md](topics/11-workflows-suspend-resume/More_on_Workflows.md) Part 1 §3–§14 (the concepts) and **Part 2 §25–§45 (Mastra in depth: what it is, where it fits, every building block, a run traced across three requests)**. This file is the *build* plan: what changes in DocMind, in which order, and how each step is tested.

Same shape as [agents-plan.md](agents-plan.md) and [background-jobs-plan.md](background-jobs-plan.md): tracker, the brief, the problem, how Mastra works, design, rules, steps with tests, what's left out, decisions, results log, code facts, research facts.

## Contents

0. Start here + tracker
1. The brief (what Shiv asked for)
2. The problem in one picture
3. Mastra in plain words (each piece, and why it's used)
4. Design
5. Rules to follow while building
6. Roadmap (build order, with tests)
7. File edits, file by file
8. Test checklist
9. What this phase deliberately does NOT cover
10. Decisions (D1–D7 recommended, D8–D10 decided)
11. Results log
12. Code facts (what the code looks like today)
13. Research facts + sources (checked 2026-11-07)

---

## 0. Start here + tracker

**For Shiv, before WF.0:** read the topic [README.md](topics/11-workflows-suspend-resume/README.md), then [More_on_Workflows.md](topics/11-workflows-suspend-resume/More_on_Workflows.md) §3–§14 (why the server can't wait, state machines, double messages, changing the subject, errors in a workflow) and Part 2 (§25–§45, Mastra; §31 "A run's life" is the one to read twice), then §3 of this file. Answer the open decisions in §10, or say "go with the recommendations".

**For Claude:** read [CLAUDE.md](CLAUDE.md), then this file. Build **one step at a time** (WF.0 → WF.8), explain each Mastra piece as it's introduced, let Shiv review, run the step's tests, fill in §11, tick the tracker, then move on. Never run `git commit`/`git push`. Code markers for this phase: `WF.N —`. **WF.1 (the proof of concept) is a gate:** nothing touches the chat until it passes.

### Tracker

| Step | What | Status | Est. |
|---|---|---|---|
| WF.0 | Install + compatibility check (CJS, Node, TS, telemetry off) | ✅ 2026-11-24 (§11) | 0.5–1 h |
| WF.1 | **Proof of concept** (`npm run step8`): suspend → persist → kill → resume in a new process → duplicate resume → crash mid-step | ✅ 2026-11-24 (§11) | 1.5–2 h |
| WF.2 | Pointer table `quiz_workflow_runs` + repository (SQL on Neon by hand; one active run per chat, `waiting` or `running`) | ✅ 2026-11-24 | 1 h |
| WF.3 | The real quiz workflow (3 steps, one `ask-user` pause; steps call the existing services; errors become an `outcome`; Mastra on first use + fallback) + in-process tests | ✅ 2026-11-24 | 2–3 h |
| WF.4 | Reply reader ("yes", "second one", "the React document", "cancel"; free rules only for short non-questions) + eval with a trap set | ✅ 2026-11-25 | 2 h |
| WF.5 | Wire into `prepareChat` + both chat routes + the button's resume route | ⬜ | 2–3 h |
| WF.6 | Frontend: `quiz` SSE event opens the modal, the button resumes the same run | ⬜ | 1.5–2 h |
| WF.7 | Full test pass (HTTP, browser, restart, race) + live check on Render/Vercel | ⬜ | 2 h |
| WF.8 | Docs (CLAUDE, README, CODE_EXPLAINED, PROGRESS, walkthrough, roadmap, topic 11 More_on status) | ⬜ | 1–2 h |

Estimates assume Claude writes the code and Shiv reviews. Legend: ⬜ not started · 🟡 in progress · ✅ done (date + one line in §11).

### Before WF.0, Shiv does (outside the code)

- [x] Confirm §10 D1–D7: **accepted as recommended on 2026-11-24.** D8–D10 were decided the same day.
- [ ] Decide whether the PoC may create Mastra's tables in the **production Neon database** (local `.env` = production, CLAUDE.md §5). The recommendation (D3) keeps them in a separate Postgres schema `mastra`, so they never mix with yours.

---

### 0.1 Review of 2026-11-24: what changed, and why

Shiv's call: build 8a as planned, with all of these. Each problem was checked against the code that day.

| # | Problem found | Fix | Where |
|---|---|---|---|
| 1 | A Gemini HTTP error (503, 429) throws straight out of `generateQuiz`: its retry loop only covers invalid JSON ([quiz.service.ts:154-169](src/services/quiz.service.ts#L154-L169), [llm.service.ts:27-29](src/services/llm.service.ts#L27-L29)), and the call has no timeout. Inside a step that ends the run `failed` and leaves the pointer `running` | `generate-quiz` catches every error → `{ outcome: 'error' }`; the quiz's Gemini call gets a 60 s timeout (optional `timeoutMs`, additive) | §4.2, §4.8, rule 15 |
| 2 | Only `waiting` runs were looked up, so the "already being made" and 3-min stale rules had nothing to read, and a second "quiz me" during generation would start a second quiz | "active" = `waiting` or `running`; the unique index covers both; the pointer row is inserted before `run.start()`; a reply claims the row with a conditional `UPDATE` | §4.4, §4.6, rules 7 + 16 |
| 3 | The free reply rules would hijack real questions: "what is react?" matches a filename, "what does the first chapter say?" matches "first" | rules only take short replies that aren't questions; the rest goes to the LLM; a trap set in the eval | §4.5, WF.4, rule 17 |
| 4 | Deleting a document or session left pointer rows and snapshots behind, and D8 kept snapshots, which hold quiz questions from that PDF | each run's snapshot is deleted when it ends; document and session deletes cancel and delete the user's active runs | §4.3, §4.4, D8, rule 18 |
| 5 | A Mastra or storage failure would break the quiz offer, and building Mastra at boot could stop the API from starting | today's `buildQuizOffer` + button stays as the fallback; Mastra is built on first use | §4.3, §4.6, rule 19 |
| S | Two pause points (`choose-document`, `confirm`), skip-confirm logic and a `waiting_for` column | one `ask-user` step: 1 candidate → "Want it?", several → "Which one?"; picking a document = yes | §4.2, §4.4, §4.5 |

Also decided that day: D8 (changed), D9 and D10 (§10). Phase 8b was redesigned as a Mastra agent inside this workflow (§9). A review loop ("change question 2") was considered and left out (§9).

---

## 1. The brief (what Shiv asked for, 2026-11-07)

**Goal:** use Mastra's durable workflows *inside* DocMind. **Not** to turn DocMind into a Mastra app.

**This phase (workflows only), learn and build:** Mastra workflows and steps · persistent workflow storage on Postgres · `suspend()` / `resume()` · human-in-the-loop · state that survives a server restart · correct handling of concurrent resumes and failures.

**The flow:**
1. A user asks for a quiz.
2. The system works out the relevant document.
3. If needed, the workflow asks the user to pick a document.
4. The workflow suspends, and its state is saved.
5. The user answers in a later chat message.
6. DocMind finds the pending workflow for that authenticated user **and** chat session.
7. Mastra resumes it.
8. The workflow calls the existing `quiz.service.ts`.
9. The quiz goes back to the frontend.

Natural replies must work: "yes", "second one", "the React document", "cancel".

**Constraints (kept as rules in §5):**
1. Keep the Gemini integration.
2. Keep the existing agent.
3. Don't move the tools to Mastra.
4. No new quiz engine.
5. Reuse `quiz.service.ts`, document lookups, validation and business logic.
6. Mastra only does orchestration, execution state, suspend and resume.
7. Express stays.
8. Chat architecture and SSE behaviour stay.
9. Auth, ownership checks and session isolation stay in DocMind.
10. No unnecessary dependencies or architecture changes.

**Later, NOT now:** `createTool()`, a Mastra quiz agent, agent + tools inside workflows.

**Approach asked for:** inspect the repo → find the integration points → the smallest architecture → verify Mastra's APIs, packages, Postgres storage and Node requirements from official sources → explain the plan and its trade-offs → build step by step, starting with a proof of concept (suspend, persist, restart, resume, duplicate resume) before touching chat. Keep it educational; don't dump everything at once.

### One correction to the brief (checked in the code)

The brief says "two custom agents" and "three tools". The code has:

| Brief says | Code has |
|---|---|
| 2 agents | **1 agent loop**: `streamAgent` in [agent.service.ts](src/services/agent.service.ts) (`runAgent` only drains it for `POST /chat`). The **intent router** ([router.service.ts](src/services/router.service.ts)) uses an LLM classifier but isn't an agent: one call, no tools, no loop. |
| 3 tools | **2 tools**: `searchDocuments` and `listDocuments` ([src/tools/](src/tools)). The quiz **offer** ([quizOffer.service.ts](src/services/quizOffer.service.ts)) is plain code, not a tool. |

This doesn't change the plan: none of them are touched in this phase. It matters for describing the project accurately in posts and interviews.

---

## 2. The problem in one picture

Today (AG.5) a quiz request gets an offer plus a button. The button works because it **carries** the `documentId`, so the server remembers nothing. Typed replies don't work:

```
"quiz me"            → router: quiz_request → offer text + [Create quiz] button     ✓
   click             → POST /quiz { documentId }                                   ✓ (no memory needed)
"yes"                → router: smalltalk → "please click the Create quiz button"   ✗
"the second one"     → router: document_question → the agent searches for "second one"   ✗
"cancel"             → smalltalk → a polite sentence, nothing to cancel             ✗ (nothing was pending)
```

The second request has no idea there was an offer: HTTP requests don't share memory. On Render the process also restarts on every deploy and sleeps after ~15 min idle, so even an in-memory `Map` would lose the offer. The pending offer has to be **written to the database** and **found again** by the next message. That's suspend/resume.

---

## 3. Mastra in plain words (each piece, and why it's used)

Mastra is a TypeScript framework for AI apps: agents, tools, memory, RAG, evals, a server and **workflows**. This phase uses only the workflow engine and its Postgres storage, as a library inside Express.

| Piece | What it is | Why we use it here | DocMind equivalent today |
|---|---|---|---|
| **Step** (`createStep`) | One unit of work: an `id`, an `inputSchema` and `outputSchema` (Zod), and an `execute` function | Each stage of the quiz flow (resolve the documents, ask the user, generate) is one step | a service function |
| **`suspendSchema` / `resumeSchema`** | Zod schemas for what a step saves when it pauses, and what it must be given to continue | They make "what was the user asked?" and "what counts as an answer?" explicit and validated | nothing (it's new) |
| **`suspend(payload)`** | Called inside `execute`: stops the run *here*, saves `payload`, returns | Pause and wait for the user | — |
| **`resumeData`** | What `execute` receives when the run continues (validated against `resumeSchema`) | The user's answer, already turned into `{ action, documentId }` by our reply reader | — |
| **`bail(result)`** | Ends the whole workflow early with a result | "cancel" | — |
| **Workflow** (`createWorkflow(...).then(a).then(b).commit()`) | The steps chained into one graph, each step's output feeding the next one's input | The quiz flow as one definition you can read top to bottom | the order of calls in `prepareChat` |
| **Run** (`workflow.createRun({ runId?, resourceId? })`) | One execution of a workflow, with an id | One quiz conversation = one run | — |
| `run.start({ inputData })` / `run.resume({ step, resumeData })` / `run.cancel()` | Start, continue a suspended run, or cancel it | The three things the chat routes do | — |
| **Snapshot** | The run's whole state as JSON (input, each step's status and output, suspend payloads), one row in `mastra_workflow_snapshot` | This row *is* the durability: a new process loads it and continues | what a hand-written `state jsonb` column would hold |
| **Storage** (`WorkflowsPG` inside `MastraCompositeStore`) | Where snapshots go | Postgres on Neon, the database we already have; only the *workflows* part of Mastra's storage is switched on | — |
| **`Mastra` instance** (`new Mastra({ storage, workflows })`) | The registry that gives registered workflows their storage and logger | Without it a workflow has nowhere to save snapshots | `db/client.ts` for Drizzle |
| **Resume claim** | Inside `resume()`, Mastra changes the snapshot's status `suspended → running` only if it's still `suspended` (one atomic update). A second resume of the same suspension fails with `WORKFLOW_RESUME_ALREADY_CLAIMED` | Two clicks, or a click plus a typed "yes", can't make two quizzes | the conditional `UPDATE … WHERE status='suspended'` a hand-rolled version would need |

**What Mastra does NOT know about:** users, sessions, ownership, the router, SSE, Express or your document rules. That stays in DocMind (§4.1).

**Honest tradeoff (written 2026-11-24):** for one pause in a 3-step line, Mastra is more than the problem needs. The pointer table (which DocMind keeps anyway), one conditional `UPDATE … WHERE status = 'waiting'` and a direct `generateQuiz()` call would do the same job in roughly 150 lines of your own code, with no ~89 MB package, no second set of tables, and no recovery, telemetry and logger defaults to switch off. It's chosen anyway because learning a durable workflow engine is the point of this phase. The boundary rule (§4.1) keeps it swappable, and the PoC's `inspect` mode shows what a hand-rolled `state jsonb` would hold. Mastra earns its weight with many workflows, branches and loops, several pauses in one run, retries and run history: none of which this first workflow needs.

---

## 4. Design

### 4.1 Who does what

| Concern | Owner | Where |
|---|---|---|
| Who is asking (JWT) | DocMind | `requireAuth`, `req.user.id` (unchanged) |
| Is this the caller's document? Is it ready? | DocMind | `checkDocumentReady`, `listDocuments` (unchanged, called *from* steps) |
| Generating + validating + shuffling the quiz | DocMind | `generateQuiz()` in `quiz.service.ts` (unchanged, called from the last step) |
| "Is a quiz waiting or being made in this chat?" + the claim on a reply | DocMind | the pointer table `quiz_workflow_runs` (§4.4) |
| Falling back to today's offer + button when Mastra is unavailable | DocMind | `quizWorkflow.service.ts` + the chat routes (§4.6) |
| What the user's reply means | DocMind | `interpretQuizReply()` (§4.5) |
| When the pending quiz expires, or is dropped because the subject changed | DocMind | pointer table + `prepareChat` |
| SSE events, saved history | DocMind | chat routes (additive changes only) |
| The step order, pausing, saving state, continuing from a fresh process, refusing a double resume | **Mastra** | `src/mastra/` |

**Boundary rule:** only `src/mastra/**` and `src/services/quizWorkflow.service.ts` import Mastra. Everything else calls `quizWorkflow.service.ts`, which returns DocMind-shaped results (`{ ok, ... }`), the same way only `repositories/` touches SQL. Swapping Mastra for a hand-rolled engine later would touch only those files.

### 4.2 The workflow

*Revised 2026-11-24: one `ask-user` step replaces the first draft's `choose-document` + `confirm` (simplification S), and `generate-quiz` catches every error (fix 1). See §0.1.*

```
quiz-workflow  (input: { userId, scope: 'one' | 'all', documentId? })
DocMind checks for ready documents BEFORE start(): 0 ready → a sentence, no run, no rows (D10)

  resolve-document ──(0 ready: only if deleted since that check)──► bail { outcome: 'nothing_ready' }
        │ candidates = the ready documents in scope (1 or more)
        ▼
  ask-user ──suspend { candidates }──► ⏸ waits for the user
        │   1 candidate:  "I can make a 5-question quiz from x.pdf. Want it?"
        │   several:      "Which document? 1. a.pdf  2. b.pdf"
        │ resume { action: 'choose', documentId }    ("yes" with 1 candidate = choose it; picking one = yes)
        │ resume { action: 'cancel' }  → bail { outcome: 'cancelled' }    (D9)
        ▼
  generate-quiz ── generateQuiz({ documentId, userId, timeoutMs })   re-checks ownership + ready
        │           ok                                        → { outcome: 'quiz', ... }
        │           not ok (404 / 409 / 502) OR anything thrown
        │           (Gemini 503 / 429, timeout, DB error)     → { outcome: 'error', status, message }
        ▼
  output { outcome: 'quiz', documentId, filename, quiz }  |  { outcome: 'error', status, message }
```

- **`resolve-document`** never suspends. One-document chat → that document (already checked by `prepareChat`). "All documents" → the caller's **ready** documents via `listDocuments(userId)` (the same logic as `buildQuizOffer`, moved into a shared helper so it isn't duplicated). Its `nothing_ready` bail is only a guard: the service already checked before `start()` (D10).
- **`ask-user`** suspends with the **candidate list as it was shown**, so "the second one" means the second one the user saw, not whatever is second now. One step covers both questions: with one candidate it asks "Want it?", with several "Which one?". Its `resumeData` is only ever `choose` or `cancel`; the reply reader (§4.5) turns a "yes" into `choose` of the only candidate. `if (!resumeData) return await suspend(...)` is the step's first line (rule 8b).
- **`generate-quiz`** calls the existing `generateQuiz()`. That already re-runs `checkDocumentReady` (404 if deleted, 409 if not ready) and retries once on an **invalid** reply. It does **not** catch a Gemini HTTP error: `generateAnswer` throws on any non-OK status ([llm.service.ts:27-29](src/services/llm.service.ts#L27-L29)), and the retry loop ([quiz.service.ts:154-169](src/services/quiz.service.ts#L154-L169)) only handles bad JSON. So the step wraps the call in `try/catch`, and every failure becomes `{ outcome: 'error' }` and **ends** the run (D6). A step never throws (rule 15): a thrown error would end the run as `failed` and leave the pointer `running`.
- **Timeout (fix 1):** the quiz's Gemini call gets `QUIZ_GENERATE_TIMEOUT_MS` = 60 s (Gemini has taken 25–53 s on slow days, CLAUDE.md §9) through an optional `timeoutMs` on `generateAnswer` (an `AbortSignal.timeout`), passed down by an optional field on `generateQuiz`'s input. Both are additive: `POST /quiz` and every other caller behave exactly as today. (ISSUES.md #8, "no timeout and no retry on any Gemini fetch", stays open for everything else.)
- Mastra step retries stay **off**: `generateQuiz` already retries once, and more retries would spend free-tier calls.
- **The quiz is the run's output**, so it sits in the snapshot (~2–4 KB) only until the run ends; then the snapshot is deleted (fix 4, D8). Quizzes still aren't saved anywhere server-side (same as today).

### 4.3 Storage

```ts
// src/mastra/index.ts (sketch, finalised in WF.0/WF.1)
// built on FIRST USE by getMastra(), not at boot (fix 5)
new Mastra({
  storage: new MastraCompositeStore({
    id: 'docmind',
    domains: { workflows: new WorkflowsPG({ pool, schemaName: 'mastra' }) },   // only the workflows domain
  }),
  workflows: { quizWorkflow },
  logger: false,               // or a quiet logger (D7); our pipelineLogger stays the main log
  recovery: { workflows: 'off' },   // D5: no boot-time restart of RUNNING runs (default is 'auto'; key checked 2026-11-10)
})
// belt and braces on the workflow itself: createWorkflow({ ..., options: { autoRestartActiveRuns: false } })
```

- **One connection pool:** `WorkflowsPG` accepts an existing `pg.Pool`. `db/client.ts` creates the pool but doesn't export it yet. WF.0 adds `export const pool`, so there are no extra Neon connections.
- **A separate Postgres schema `mastra`** (D3): Mastra's tables (`mastra_workflow_snapshot`, plus its run-ownership table) live in `mastra.*`, away from `public.*` where your tables are. Mastra creates them itself when its storage starts. That's the one exception to "every table by hand SQL" (CLAUDE.md §5), and it gets written down there. WF.0 checks whether it also creates the schema, or whether you run `CREATE SCHEMA mastra` once.
- **Only the workflows domain is switched on**, so no memory, observability, agent or eval tables.
- **Telemetry off:** `@mastra/core` sends anonymous usage events to PostHog unless `MASTRA_TELEMETRY_DISABLED=1` (read in its source, §13). Set it in `.env`, `.env.example` and Render.
- **Started on first use (fix 5).** `getMastra()` builds the instance the first time a quiz needs it, the same way `queue/connection.ts` opens Redis on first use. If building it (or its storage `init()`) fails, the error goes through `summarizeError`, the quiz falls back to today's offer + button (§4.6), and the API keeps running. Nothing Mastra-related runs at boot, so a storage problem can't stop the API from starting.
- **Snapshots don't outlive their run (fix 4, D8).** When a run ends (quiz sent, cancelled, error, expired, superseded, deleted), `deleteWorkflowRunById` removes its snapshot. The PoC (WF.1) keeps its own runs until `cleanup`, so the JSON can still be inspected while learning.

### 4.4 Finding the active run: the pointer table

Mastra finds runs by `runId` (and can list them by `resourceId`/`status`), but the chat only knows `userId` + `sessionId`, and Mastra knows nothing about ownership. So DocMind keeps a small pointer row per quiz run (D2):

```sql
-- WF.2, run by hand on Neon (kept in a comment beside the table in schema.ts)
CREATE TABLE quiz_workflow_runs (
  run_id      text PRIMARY KEY,           -- Mastra's runId (we generate it: randomUUID())
  user_id     text NOT NULL,
  session_id  text NOT NULL,
  status      text NOT NULL,              -- 'waiting' | 'running' | 'done'   (DocMind's view; Mastra's snapshot is the truth for the steps)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NULL            -- now() + 30 min, set when the run suspends; NULL while running
);
-- at most ONE active quiz per conversation (waiting for the user OR being generated), enforced by Postgres
CREATE UNIQUE INDEX quiz_workflow_runs_one_active
  ON quiz_workflow_runs (user_id, session_id) WHERE status IN ('waiting', 'running');
```

The first draft's `waiting_for` column is gone: with one `ask-user` step there's only one place a run can wait.

**Life of a row (fix 2):**

```
"quiz me"  INSERT status 'running'          ← BEFORE run.start(); a 23505 = a quiz is already active in this chat
           run.start() suspends             → UPDATE status 'waiting', expires_at = now() + 30 min
"yes"      claim: UPDATE … SET status = 'running', expires_at = NULL
                  WHERE run_id = $1 AND user_id = $2 AND status = 'waiting' RETURNING run_id
             0 rows → someone else claimed it first: "That quiz is already being made" (Mastra not called)
           run.resume(…) → quiz sent        → UPDATE status 'done' + snapshot deleted
```

- **Every query filters `user_id`** together with `session_id` or `run_id`, with `userId` a required parameter. Another user's `sessionId` or `runId` finds nothing.
- **Why insert before `start()`:** two "quiz me" in one chat at the same moment can't both start a run (the second insert hits the unique index), and a crash right after `start()` still leaves a row the stale rule can close. If `start()` itself fails, the row is marked `done` and the fallback offer is sent (fix 5).
- **Why DocMind claims as well:** the conditional `UPDATE` answers the loser of a click + typed "yes" race without touching Mastra. Mastra's own guard stays as the second one, proven in WF.1: the losing `resume()` throws `WORKFLOW_RUN_NOT_SUSPENDED` (it read the status after the winner's claim) or `WORKFLOW_RESUME_ALREADY_CLAIMED` (both read `suspended` first); treat either as "already taken".
- **Stale running rows:** `running` for longer than `QUIZ_RUN_STALE_MS` (3 min, longer than 2 attempts × the 60 s timeout) means the process died mid-step. Boot recovery is off (D5), so nothing restarts it: the next message marks it `done` (logged) and is handled normally.
- **Expiry is lazy** for waiting rows: checked when the row is read. No cron, no BullMQ delayed job.
- **A new quiz while one is waiting:** the old one is cancelled first (pointer `done`, `run.cancel()`, snapshot deleted), then the new one starts. **While one is running:** "Your quiz is still being made", and no second run.
- **Deletes (fix 4):** `DELETE /sessions/:id` cancels that session's active runs and deletes its pointer rows and snapshots. `DELETE /documents/:id` cancels **all of the user's active runs** and deletes their rows and snapshots: a waiting candidate list may include that document, the pointer row has no document id, and saying "quiz me" again is cheap.

### 4.5 Reading the user's reply

`interpretQuizReply(message, candidates) → { action: 'choose', documentId } | { action: 'cancel' } | { action: 'unclear' } | { action: 'unrelated' }`

Same hybrid idea as the router: **rules first (0 API calls), then the LLM when the rules aren't sure.** **The rules only fire on a short reply that isn't a question** (fix 3): at most ~6 words, no `?`, and not starting with a question word (what, why, how, who, when, where, which, is, are, does, can, explain, tell). Anything else goes to the LLM, so a filename or a number inside a real question can never hijack it.

| Reply | Rule | Result |
|---|---|---|
| "yes", "sure", "go ahead", "ok do it" | yes-word list | 1 candidate → `choose` it; several → `unclear` ("Which one?") |
| "no", "cancel", "never mind", "stop" | no-word list | `cancel` |
| "2", "second one", "the last one", "first" | number / ordinal against `candidates` | `choose` (out of range → `unclear`) |
| "the React document", "react" | words matched against candidate filenames | exactly one match → `choose`, several → `unclear` (ask again, listing the matches) |
| "what is react?", "what does the first chapter say?" | a question, so **no rule fires** → LLM | usually `unrelated` |
| anything else | **LLM** (Flash-Lite, JSON mode, temp 0, Zod, given the candidates with numbers) | any of the four |

- **`unclear`:** the run stays suspended and the reply asks again ("Which one? 1. react-intro.pdf 2. react-hooks.pdf"). No Mastra call.
- **`unrelated` (D4):** cancel the run (`run.cancel()`, pointer `done`, snapshot deleted) and route the message normally, so it gets a normal answer. A "yes" three messages later is ambiguous, and dropping the offer is the safe reading.
- The LLM's answer is only a label. Code decides what happens next. The LLM's `documentId` must be one of the candidates (checked in code), otherwise `unclear`.

### 4.6 Where it plugs into the chat

`prepareChat` gets one new step **before the embedding** (today's step 2, [chat.service.ts:254](src/services/chat.service.ts#L254)), so a "yes" costs 0 embedding calls and 0 router calls:

```
validate → (one doc: checkDocumentReady) → NEW: active = findActiveRun(sessionId, userId)
                                            (a lookup error is logged and treated as "none": chat must not break, fix 5)
   waiting, not expired → interpret reply:
       choose     → kind 'workflow', op 'resume'     (the route claims + resumes, step 7)
       cancel     → kind 'workflow', op 'cancel'     (resume with { action: 'cancel' } → bail, D9)
       unclear    → kind 'workflow', op 'ask_again'  (no Mastra call)
       unrelated  → cancel the run, then continue below as normal
   waiting, expired       → cancel the run, continue below as normal
   running, < 3 min       → kind 'workflow', op 'busy'  ("Your quiz is still being made…"), no routing
   running, ≥ 3 min       → stale: pointer 'done' (logged), continue below as normal
   none                   → continue below as normal
embed → history → route:
   quiz_request → 0 ready documents → a sentence, no run (D10)
                  otherwise         → kind 'workflow', op 'start'
   smalltalk / document_question → unchanged
```

- **`prepareChat` never runs the workflow itself.** It returns *what to do*, and the route does it at step 7. Starting or resuming can take 5–15 s (quiz generation), and the stream must already be open so the user sees "Writing your quiz…". Services still never touch `res`.
- **Fallback (fix 5):** if starting the run fails (Mastra can't be built, or its storage errors), the route marks the pointer `done`, logs the cause, and sends today's `buildQuizOffer` text + `quiz` / `quiz_picker` button instead. So `buildQuizOffer` and the old action shapes stay.
- The user message is saved as today. The assistant reply that's saved is the text the user saw ("Which document? …", "Here's your quiz on **x.pdf**.", "Okay, cancelled.").
- The `"click the Create quiz button"` lines in the smalltalk prompt ([chat.service.ts:104](src/services/chat.service.ts#L104)) and the agent instruction ([agent.service.ts:76](src/services/agent.service.ts#L76)) are **reworded** in WF.5 ("answer the question above, or use its buttons"), not removed, because the button-only offer can still appear as the fallback.
- **One-document chats:** `checkDocumentReady` runs before the active-run check, so a deleted document answers 404 first. That's fine: deleting a document also removes the user's active runs (§4.4) and that document's chat messages.

### 4.7 What the client receives (additive only)

| Channel | Change |
|---|---|
| `/chat-stream` | existing `status` event reused: `{ text: 'Writing your quiz from x.pdf…' }` before generating. **New `quiz` event** `{ runId, documentId, filename, quiz }`. Existing `action` event gets **one new shape** carrying the `runId`: `{ type: 'quiz_ask', runId, candidates: [{ documentId, filename }] }` (1 candidate → [Create quiz] [Cancel], several → one button per document + [Cancel]). The old `quiz` / `quiz_picker` shapes stay for the fallback (§4.6) |
| `/chat` JSON | adds `quiz` (same shape) and the new `action` shape |
| **New** `POST /quiz-runs/:runId/resume` | JSON `{ action: 'choose', documentId } \| { action: 'cancel' }` → `{ quiz }` or `{ text }`. What the **buttons** call. Same pointer claim + Mastra resume as a typed reply, so a click and a typed "yes" go through **one path**. 404 if the run isn't the caller's, 409 if it isn't waiting any more (already claimed, done or expired) |
| `POST /quiz` | unchanged (the header's "Generate quiz" button still uses it directly; it isn't a conversation) |

The frontend's `dispatch()` has no `default` case, so older bundles skip `quiz` and the new `action` type (CLAUDE.md §9). They'd just show the text. Buttons aren't saved with the chat history, so after a reload the question shows as plain text; typing still works, because the run is on the server.

### 4.8 Failures and races

| Situation | What happens | Who handles it |
|---|---|---|
| Click + typed "yes" at the same moment | The pointer claim (conditional `UPDATE waiting → running`) lets exactly one through. The other gets **409** "That quiz is already being made" (button) or that sentence (chat), and Mastra is never called for it. Mastra's own claim (`WORKFLOW_RESUME_ALREADY_CLAIMED`) is the second guard | DocMind claim + Mastra claim (verified in source, §13); proven in WF.1 and WF.7 |
| Two "quiz me" in one chat at the same moment | The second pointer `INSERT` hits the unique index (`23505`) → "Your quiz is already being made" | Postgres unique index (fix 2) |
| Server restarts while a run is **suspended** | Nothing lost: the snapshot is in Postgres, and the next message resumes it | Mastra storage; proven in WF.1 |
| Server dies **mid-generate** | Recovery is off (D5), so nothing restarts the run (auto would spend a Gemini call on a quiz nobody receives). The pointer stays `running`; after 3 min the next message marks it `done` and is handled normally | DocMind stale rule; tested in WF.1 (kill mid-step) |
| Gemini HTTP error (503 "high demand", 429) or a hung call | Caught inside `generate-quiz` (a thrown error would otherwise end the run `failed`), 60 s timeout → `{ outcome: 'error' }` → "Couldn't make the quiz right now, say 'quiz me' to try again" | the step's `try/catch` + timeout (fix 1) |
| Gemini returns an invalid quiz twice | `generateQuiz` → 502 → `{ outcome: 'error' }` → run ends (D6) | existing `generateQuiz` |
| Document deleted while waiting | `DELETE /documents/:id` cancels the user's active runs. If it slips through (deleted between the claim and generation), `generateQuiz` → 404 → "That document isn't available any more" | fix 4 + existing `checkDocumentReady` |
| Expired (30 min) | Lazy: the next message sees it, cancels it, routes normally | DocMind |
| Another user's `runId` on `/quiz-runs/:id/resume` | **404** (pointer not found for this user). Mastra is never called | DocMind (auth rule: 404 not 403) |
| Mastra can't start, or its storage fails at `start()` | Pointer marked `done`, the cause logged through `summarizeError`, and the user gets today's offer + button instead. Chat is unaffected | fallback (fix 5) |
| Mastra/Postgres error during a resume | `withErrorHandling` → 503 JSON / `event: error`; the pointer is marked `done` so the chat isn't stuck | existing error handling |
| The active-run lookup itself fails (a DB hiccup) | Logged, treated as "no active run", and the message is routed normally | `prepareChat` (fix 5) |
| "cancel" typed while the quiz is being generated | The pointer is `running`, so the reply reader isn't consulted: "Your quiz is still being made". (`run.cancel()` wouldn't stop the in-flight Gemini call anyway: `generateQuiz` doesn't listen to `abortSignal`) | DocMind + Mastra cancel semantics (§13) |

---

## 5. Rules to follow while building

1. **Mastra orchestrates, DocMind decides.** Steps *call* existing services (`generateQuiz`, `listDocuments`, `checkDocumentReady`); no business logic is rewritten inside a step.
2. **Only `src/mastra/**` and `quizWorkflow.service.ts` import Mastra.**
3. **No Mastra agents, tools, memory, server or model providers** in this phase. Gemini stays on plain `fetch`. (Agents and tools come in 8b, §9.)
4. **`userId` only from `req.user.id`**, passed into the workflow input, and re-checked by `checkDocumentReady` inside `generate-quiz`. A run is only ever found through the pointer table, filtered by `user_id`.
5. **Someone else's run = 404**, the same as a missing one.
6. **The model never changes workflow state.** The LLM fallback only labels a reply; code validates it (candidate ids) and calls `resume`/`cancel`.
7. **Resume is a claim, twice.** DocMind claims the pointer row (`waiting → running`, one conditional `UPDATE`) before calling `resume()`; never call `resume()` without winning that claim. Treat `WORKFLOW_RESUME_ALREADY_CLAIMED` **and `WORKFLOW_RUN_NOT_SUSPENDED`** (WF.1: the loser of a race can get either) as a normal outcome, not a crash.
8. **Every Mastra result is checked by `status`** (`success` / `suspended` / `failed` / `canceled`); no assumption that `start()` finished. A `bail()` also ends as **`success`** (the bail payload becomes the result), so a `success` is read through the output's `outcome` field (`quiz` / `cancelled` / `nothing_ready` / `error`).
8b. **Nothing with a side effect above the `suspend` check.** A resumed step runs `execute` again from its first line; anything before `if (!resumeData) return suspend(...)` runs twice. Gemini calls and DB writes go below it, or in the next step.
9. **Suspend payloads hold only what the user was shown** (candidate ids + filenames), never chunks, embeddings or quiz text.
10. **SSE changes are additive**, and the frontend's `dispatch()` keeps no `default`.
11. **Re-check the world on resume** (ownership + ready), because time passed while the run was paused.
12. **Logging stays a feature:** every workflow transition logs through `pipelineLogger` (new `workflow` theme), and errors go through `summarizeError`.
13. **Testing against real data:** local `.env` = production Neon. Tests use throwaway guests, delete **only the ids they created** (users, documents, pointer rows, Mastra runs via `deleteWorkflowRunById`), and the PoC uses its own workflow id (`poc-…`).
14. **Telemetry off everywhere** (`MASTRA_TELEMETRY_DISABLED=1`).
15. **A step never throws** (fix 1). Every error inside a step becomes an `outcome`, so a run always ends `success` with a readable result and the pointer can always be closed.
16. **One active quiz per chat** (`waiting` or `running`), enforced by the unique index, with the pointer row written before `start()` (fix 2).
17. **The free reply rules only read short replies that aren't questions;** everything else goes to the LLM (fix 3).
18. **No quiz content outlives its run:** snapshots are deleted when a run ends, and document/session deletes remove active runs (fix 4).
19. **The quiz never depends on Mastra being up:** Mastra starts on first use, and any failure to start a run falls back to today's offer + button (fix 5).

---

## 6. Roadmap (build order, with tests)

### WF.0: Install + compatibility check (no app behaviour change)

- `npm install @mastra/core@1.82.0 @mastra/pg@1.35.0` (exact versions, D1). Check what else it pulls in and the `node_modules` size.
- `package.json` `engines.node`: `"22.x"` → `">=22.13 <23"` (Mastra needs ≥ 22.13; check what Render actually runs).
- `.env` / `.env.example` / Render: `MASTRA_TELEMETRY_DISABLED=1`.
- `db/client.ts`: `export const pool` (one line).
- **Checks:** `import { createWorkflow, createStep } from '@mastra/core/workflows'` compiles under your CommonJS `tsconfig` (`npx tsc --noEmit`), runs under `ts-node-dev`, and survives `npm run build && npm start`. Process memory before/after the import (`process.memoryUsage().rss`), since Render free has 512 MB. Find out whether `WorkflowsPG` creates the `mastra` schema itself, and that building the `Mastra` instance can wait until first use (fix 5). (The boot-recovery key is already known: `recovery: { workflows: 'off' }`, §13.)
- **Explain:** what a CJS/ESM dual package is, and why it decides whether this works at all.

### WF.1: Proof of concept: `src/step8-mastra-poc.ts` (`npm run step8 <mode>`) — the gate

A toy 2-step workflow (`poc-approval`): step 1 suspends asking "approve?", step 2 finishes. No DocMind code, no Gemini. Modes:

| Mode | Shows | Pass when |
|---|---|---|
| `start` | create a run, `start()`, print `runId` + the suspended step + payload, **exit the process** | status `suspended`, a row in `mastra.mastra_workflow_snapshot` |
| `inspect <runId>` | `getWorkflowRunById` + the raw snapshot JSON | you can point at the saved suspend payload |
| `resume <runId>` | a **fresh process** rebuilds the run from the id and resumes | status `success`: state survived a restart |
| `race <runId>` | two `resume()` calls at once (`Promise.allSettled`) | exactly 1 fulfilled, 1 rejected (WF.1: the loser got `WORKFLOW_RUN_NOT_SUSPENDED`, not `…ALREADY_CLAIMED`; which one depends on timing, see §11) |
| `again <runId>` | resume an already finished run | a clear error, nothing re-runs |
| `crash` | a step that waits 20 s; kill the process mid-step; start again with recovery `off` and `auto`, then call `restartAllActiveWorkflowRuns()` by hand | `off`: run stays `running` (our stale rule handles it). `auto` (WF.1): **also** stays `running`, because only Mastra's own server calls the sweep; called by hand it re-runs the step from line 1. Behaviour written down |
| `cancel <runId>` | `run.cancel()` on a suspended run | status `canceled`, and resume is refused |
| (all modes) | a counter inside step 1's `execute`, printed each time it runs | proves the paused step runs **again from its first line** on resume (More_on §32) |
| `bail` | a variant where the resume answer is "no" and the step calls `bail()` | run status `success`, result = the bail payload (so `outcome` is what matters; this is D9's cancel path) |
| `throw` | a step that throws | run status `failed`: shows why rule 15 catches errors inside steps |
| `cleanup` | delete every `poc-approval` run | 0 rows left |

**Explain while building:** what's inside a snapshot, where `suspend()` returns to, why the second process can continue, how the claim works (one conditional UPDATE), and why recovery-on-boot is risky for a step that spends money.

**Shiv reviews the output. Nothing in the chat changes until this passes.**

### WF.2: Pointer table + repository

SQL from §4.4 run on Neon by Shiv, the table added to `schema.ts` with the SQL in a comment, and `quizWorkflowRuns.repository.ts` with `createActiveRun` (insert `running`), `findActiveRun(sessionId, userId)` (`waiting` or `running`), `claimWaitingRun(runId, userId)` (the conditional `UPDATE … RETURNING`), `markWaiting` / `markDone(runId, userId)`, `listActiveRunsForUser(userId)`, `deleteRunsForSession(sessionId, userId)`. Every function takes a required `userId`. **Test:** in-process, two guests: one active run per session (a second insert while the first is `running` **or** `waiting` hits the unique index), two concurrent claims → exactly one row back, expiry and stale checks, another user finds nothing, cleanup by id.

### WF.3: The real quiz workflow

`src/mastra/workflows/quiz.workflow.ts` (3 steps, §4.2), `src/mastra/index.ts` (`getMastra()`, built on first use, §4.3), `quizWorkflow.service.ts` (`startQuizRun`: ready check (D10) → pointer insert → `start()`, or a "fallback" result if Mastra fails; `resumeQuizRun`: claim → `resume()`; `cancelQuizRun`; snapshot deleted at every ending; each returns DocMind-shaped results and updates the pointer). Plus the optional `timeoutMs` on `generateAnswer` and `generateQuiz` (fix 1). **Tests (in-process, real Neon, throwaway guest + small PDF):** one doc → suspends at `ask-user` → choose → real quiz; All with 2 ready → choose #2 → quiz, no second question; cancel → `success` + `outcome: 'cancelled'`; document deleted while paused → `error` outcome; 0 ready → no run, no rows; **a faked Gemini 503 and a faked hang (global `fetch` faked, as in AG.4) → `outcome: 'error'`, run `success`, pointer `done`**; snapshot gone after every ending; Mastra storage made to fail → the fallback result. One run with a fake `generateQuiz` to keep Gemini calls down.

### WF.4: Reply reader

`src/services/quizReply.service.ts` + `src/schemas/quizReply.schema.ts` (Zod + Gemini response schema), and an eval in `step8 replies`: ~40 labelled replies ("yes", "yep go", "2", "second one", "the last one", "react", "the React document" with 2 React files, "cancel", "nah", "what's in chapter 3?", "yes but about chapter 2", …) **plus the trap set** (fix 3): "what is react?", "what does the first chapter say?", "is the second one about hooks?", "explain 2 more". **Pass:** 0 harmful mistakes (a cancel read as a choice, a wrong document chosen, a question read as a choice), LLM used only on the replies the rules don't take. The LLM count gets written down.

### WF.5: Chat + routes

`prepareChat` kind `'workflow'` with ops `start` / `resume` / `cancel` / `ask_again` / `busy` (§4.6), both chat routes run the op at step 7 with a `status` event + the `quiz` event (§4.7), the fallback to `buildQuizOffer` when a start fails (fix 5), `POST /quiz-runs/:runId/resume` (new `quizRuns.routes.ts`, behind `requireAuth` like every data route), `DELETE /sessions/:id` and `DELETE /documents/:id` cancel + delete the user's runs (fix 4), the prompt lines reworded, `pipelineLogger` `workflow` theme, config `QUIZ_RUN_TTL_MS` (30 min), `QUIZ_RUN_STALE_MS` (3 min), `QUIZ_GENERATE_TIMEOUT_MS` (60 s). **Tests (HTTP, local server):** the §8 list.

### WF.6: Frontend

`types/chat.ts` (the `quiz_ask` action + `quiz` payload), `api/chat.ts` (`quiz` case), `api/quizRuns.ts` (new), `useChat` (`onQuiz`), `useQuiz.show(quiz, filename)` (open the modal with a quiz that already exists; "Regenerate" still uses `POST /quiz`), `ChatTurn`: `quiz_ask` buttons → `POST /quiz-runs/:runId/resume` (1 candidate → Create quiz + Cancel, several → one per document + Cancel); the old `quiz` / `quiz_picker` buttons keep working for the fallback. **Tests:** headless Chromium: type "quiz me" → "yes" → the modal opens; All docs → "the second one" → modal; click and type at once → one quiz; reload while waiting → typing "yes" still works (state is on the server); light/dark/375 px; 0 console errors.

### WF.7: Full pass + live

The whole §8 checklist again on a local server, then a restart test (suspend → restart the server → resume), then deploy (Render: `MASTRA_TELEMETRY_DISABLED`, Node version, memory in Render's metrics) and a live check with throwaway guests deleted by id afterwards.

### WF.8: Docs

CLAUDE.md (§3, §4 stack row, §5 env + the Mastra-tables exception, §6 layout, §7 API + SSE, §8 data model, §9 gotchas, §13), README (stack table, API, SSE table, decisions, limitations), CODE_EXPLAINED (Phase 8 section with line links), PROGRESS (topic 11 ✅), walkthrough + roadmap (how it turned out), topic 11 README + More_on (status lines, "planned" → what actually happened, a Part 3 like topic 10's, and the one-step `ask-user` design replacing the two-step one described in Part 2), `topics/OVERVIEW.md`, ISSUES.md for anything found. Topic 11 NOTES.md stays Shiv's.

**Already written before the build (2026-11-10, at Shiv's request):** topic 11 [README.md](topics/11-workflows-suspend-resume/README.md) (new), More_on Part 2 (§25–§45, Mastra in depth) + Part 1 refreshed, and "planned on Mastra" notes in PROGRESS, the roadmap, the walkthrough, README, OVERVIEW and CLAUDE.md. WF.8 turns those "planned" notes into "built" ones. Those pages still describe the first draft's 4 steps (`choose-document` + `confirm`); WF.8 updates them to the 3-step design.

---

## 7. File edits, file by file

| File | Change | Step |
|---|---|---|
| `package.json` | `@mastra/core`, `@mastra/pg`, `engines`, `"step8"` script | WF.0/1 |
| `.env.example` | `MASTRA_TELEMETRY_DISABLED=1` | WF.0 |
| `src/db/client.ts` | `export const pool` | WF.0 |
| `src/step8-mastra-poc.ts` | new: PoC modes + `replies` eval | WF.1/4 |
| `src/db/schema.ts` | `quizWorkflowRuns` table + SQL comment | WF.2 |
| `src/repositories/quizWorkflowRuns.repository.ts` | new | WF.2 |
| `src/mastra/index.ts` | new: `getMastra()`, built on first use, + storage | WF.3 |
| `src/mastra/workflows/quiz.workflow.ts` | new: 3 steps + the workflow | WF.3 |
| `src/services/quizWorkflow.service.ts` | new: start/resume/cancel/find, the only Mastra caller outside `src/mastra` | WF.3 |
| `src/services/llm.service.ts` | optional `timeoutMs` on `generateAnswer` (`AbortSignal.timeout`), additive | WF.3 |
| `src/services/quiz.service.ts` | optional `timeoutMs` on `generateQuiz`'s input, passed through, additive (`POST /quiz` unchanged) | WF.3 |
| `src/services/quizOffer.service.ts` | candidate logic shared with `resolve-document`; stays as the fallback offer (fix 5) | WF.3/5 |
| `src/services/quizReply.service.ts`, `src/schemas/quizReply.schema.ts` | new | WF.4 |
| `src/services/chat.service.ts` | active-run check before embedding, kind `'workflow'`, prompt line reworded | WF.5 |
| `src/services/agent.service.ts` | the "click the Create quiz button" line reworded | WF.5 |
| `src/routes/chat.routes.ts` | step 7 for kind `'workflow'`, `status` + `quiz` events, the fallback offer | WF.5 |
| `src/routes/quizRuns.routes.ts` + `app.ts` mount | new: `POST /quiz-runs/:runId/resume` | WF.5 |
| `src/routes/sessions.routes.ts` | cancel + delete the session's runs | WF.5 |
| `src/routes/documents.routes.ts` | cancel + delete the user's active runs (fix 4) | WF.5 |
| `src/utils/pipelineLogger.ts` | `workflow` theme | WF.5 |
| `src/config.ts` | `QUIZ_RUN_TTL_MS` (30 min), `QUIZ_RUN_STALE_MS` (3 min), `QUIZ_GENERATE_TIMEOUT_MS` (60 s) | WF.3/5 |
| `frontend/src/types/chat.ts`, `api/chat.ts`, `api/quizRuns.ts` (new), `hooks/useChat.ts`, `hooks/useQuiz.ts`, `components/chat/ChatTurn.tsx`, `App.tsx` | §WF.6 | WF.6 |
| docs | §WF.8 | WF.8 |

**Not touched:** `router.service.ts`, `src/tools/*`, `quiz.routes.ts`, every other repository, auth, the queue and worker. `agent.service.ts` changes one prompt line; `llm.service.ts` and `quiz.service.ts` only get the optional timeout.

---

## 8. Test checklist

**PoC (WF.1):** suspend → exit → resume in a new process ✓ · duplicate resume → exactly one wins ✓ · resume a finished run → refused ✓ · cancel then resume → refused ✓ · `bail` → `success` with the bail payload ✓ · a throwing step → `failed` ✓ · kill mid-step with recovery off/auto → behaviour recorded ✓ · cleanup leaves 0 rows ✓

**Chat (WF.5–WF.7):**
- [ ] One-doc chat: "quiz me" → "Want it?" (suspended at `ask-user`) → "yes" → quiz event, modal data valid (5 × 4, shuffled)
- [ ] One-doc: "quiz me" → "no thanks" → cancelled: run `success` with `outcome: 'cancelled'` (D9), pointer `done`, snapshot deleted
- [ ] All, 2 ready: "quiz me" → list → "the second one" → quiz from document #2, no second question
- [ ] All, 2 ready: "react" with one React file → that one; with two → asks again, still waiting
- [ ] All: "yes" while choosing → asks which one
- [ ] Trap replies while waiting: "what is react?", "what does the first chapter say?" → **not** read as a choice; answered normally, run cancelled (fix 3)
- [ ] All, 1 ready → "Want it?"; 0 ready → sentence, **no run, no rows** (D10)
- [ ] Waiting, then an unrelated question → normal agent answer + run cancelled
- [ ] Waiting 31 min (or TTL lowered in the test) → expired, message routed normally
- [ ] Click **Create quiz** + type "yes" at the same time → one quiz, the other gets 409 / "already being made"
- [ ] Two "quiz me" at the same time in one chat → one run (unique index)
- [ ] "cancel" while the quiz is being generated → "still being made"
- [ ] Gemini 503 / a hang during generation (faked) → "Couldn't make the quiz", run `success` + `outcome: 'error'`, pointer `done` (fix 1)
- [ ] Restart the server while waiting → "yes" still works
- [ ] A pointer stuck `running` for over 3 min (simulated) → the next message is handled normally, the row is `done`
- [ ] Document deleted while waiting → the user's active runs and their snapshots are gone (fix 4)
- [ ] `DELETE /sessions/:id` removes its pointer rows and snapshots
- [ ] After every ending (quiz, cancel, error, expiry, delete): 0 snapshot rows left for that run (fix 4)
- [ ] Mastra made to fail at start (e.g. a broken storage config in the test) → today's offer + button, chat unaffected (fix 5)
- [ ] Guest B: `POST /quiz-runs/<A's runId>/resume` → 404; B's chat with A's `sessionId` finds no active run
- [ ] Old frontend bundle (via `git archive`, like AG.4) still works: text shown, no crash
- [ ] Log: every transition visible with the `workflow` theme; Gemini calls counted (reply reader: 0 on rule matches)
- [ ] Live: same core flow on Render + Vercel; memory within limits; test data deleted by id

---

## 9. What this phase deliberately does NOT cover

- **Mastra agents and tools: that's Phase 8b (redesigned 2026-11-24; after WF.7; not planned in detail yet).** Instead of the 2026-11-10 idea (rebuild the chat agent in Mastra as a `step9` script, now dropped or optional), 8b puts a **Mastra agent inside this quiz workflow** and deploys it if it holds up:
  - `resolve-document` becomes `pick-document`: a Mastra `Agent` with two **new** `createTool()` tools in `src/mastra/tools/`, calling the same repository functions as the chat tools. `listReadyDocuments` → `listDocuments(userId)`, returning ids and only ready documents (the chat tool hides ids on purpose). `searchDocuments` → `searchSimilar(...)`, returning each hit's `documentId`. `userId` comes from code through Mastra's per-call context (field name to confirm in the 1.82.0 docs), never from a tool argument. The existing `src/tools/` files and the chat agent are not touched.
  - For "quiz me on the hooks stuff" the agent returns `{ documentId, topic }`; code checks the id is one of the user's ready documents; `ask-user` then asks once.
  - `generateQuiz` gets an optional `topic` (similarity search inside that document instead of even sampling, [chunks.repository.ts:45-52](src/repositories/chunks.repository.ts#L45-L52)). Without it the agent picks the right PDF and the quiz still ignores the topic.
  - Rules: skip the agent on a plain "quiz me" or a single candidate; `ask-user`'s `suspend()` stays the only waiting mechanism (no `requireApproval` in the live flow, so two mechanisms never fight over a "yes"); quiz generation stays a code step, not a tool (nothing for the model to decide); the agent's answer is a proposal that code validates (rule 6).
  - Eval: ~20 "quiz me on X" requests through three versions: 8a's picker, a **vector vote** (group the message's search hits by document, 0 extra model calls) and the agent. Count: right document, right topic, model calls, time.
  - Costs to accept: ~4–5 Flash-Lite calls per topic quiz (classifier + agent 2–3 + generation) vs ~2 today, out of 15/min and 500/day shared with chat; a second Gemini path (Mastra's `'google/…'` model string through the AI SDK, `GOOGLE_GENERATIVE_AI_API_KEY`) to wire into `pipelineLogger` / `withErrorHandling`; a few seconds before "Want it?" (needs a `status` event); Render memory measured again.
  - Verified in the 1.82.0 bundled docs on 2026-11-10: `createTool`, `Agent`, `requireApproval` / `requireToolApproval`, the `tool-call-approval` stream chunk + `approveToolCall()` / `declineToolCall()`, Gemini via a `'google/…'` model string with no provider package. A `createQuiz` tool behind `requireApproval` can be tried in a side script only.
- Mastra's server, playground (`mastra dev`), deployer, memory, observability, evals.
- Moving `streamAgent`, the router or the chat tools to Mastra.
- Saving quizzes or answers (still not persisted; a reload loses an open quiz, as today).
- **A review loop** ("change question 2" after the quiz arrives). Considered 2026-11-24 and left out: it would be a `review` step after `generate-quiz` that suspends again with the quiz, resumes with the change, and loops until "done" or expiry, plus a `regenerateQuestion()` in `quiz.service.ts`. Today the modal's "Regenerate" makes a whole new quiz.
- Quiz options (question count, difficulty, chapters). The schema is fixed at 5 × 4, and chunks have no chapters. (8b's optional `topic` is the one exception.)
- Workflows for anything other than the quiz.
- A hand-rolled version or LangGraph.js. More_on §15–§16 cover the comparison, §3's "honest tradeoff" note says what a hand-rolled version would cost, and the PoC's `inspect` mode shows what its `state jsonb` would hold.
- A bulk pruning job for old snapshots: each run's snapshot is deleted when it ends (D8), so none is needed.

---

## 10. Decisions

All ten are decided. D1–D7: Shiv accepted the recommendations on 2026-11-24. D8–D10 were decided the same day (Shiv: "8a as planned, with all the fixes"). D7 is settled as `logger: false` after WF.0 saw what the default logger prints (§11).

| # | Question | Recommendation / decision | Why |
|---|---|---|---|
| D1 | Version pinning | **Exact** `1.82.0` / `1.35.0` | Mastra ships very often (core is at 1.82). A surprise minor version mid-build would make results hard to compare |
| D2 | How to find the active run for a chat | **DocMind pointer table** (§4.4). Alternative: Mastra `resourceId = "<userId>:<sessionId>"` + `listWorkflowRuns({ resourceId, status: 'suspended' })`, no new table | Ownership, expiry, "one per session" and the claim stay in your code and your SQL (constraint 9), and you can query it without parsing Mastra's JSON |
| D3 | Where Mastra's tables go | **Postgres schema `mastra`** in the same Neon DB, sharing your pool | Kept apart from your tables, no extra connections, no new service |
| D4 | Unrelated message while waiting | **Cancel the run** and answer normally | A "yes" several messages later is ambiguous |
| D5 | Mastra boot recovery for `running` runs | **Off**, plus our 3-min stale rule | Auto would restart a quiz generation nobody is waiting for and spend Gemini calls |
| D6 | Quiz generation fails (invalid twice, or any error) | **End the run** with an error reply ("say 'quiz me' to try again") | Simple. Re-suspending a failed run needs time-travel/restart APIs that aren't worth learning yet |
| D7 | Mastra's own logger | **`logger: false`** (settled in WF.0: the default logger only printed a storage warning, and `false` is accepted by the types) | `pipelineLogger` is the project's log, and two loggers interleaving is noise. Mastra's errors still reach us as thrown errors, logged through `summarizeError` |
| D8 | Old snapshot rows | **Decided 2026-11-24: delete each run's snapshot when the run ends** (quiz sent, cancelled, error, expired, superseded, deleted). The PoC keeps its own until `cleanup`. *(Was: keep for now.)* | Quiz questions from a PDF the user deleted mustn't stay in `mastra.*` (fix 4) |
| D9 | How does "cancel" end the run? | **Decided 2026-11-24:** a typed or clicked cancel goes through `resume({ action: 'cancel' })` → `bail({ outcome: 'cancelled' })` → status `success`. `run.cancel()` only for runs nobody is answering: expired, unrelated message, superseded by a new "quiz me", deleted | A cancel passes the same claim as a "yes", so the two can't both win |
| D10 | 0 ready documents | **Decided 2026-11-24:** check before `start()` (no run, no rows); keep `resolve-document`'s bail as a guard for documents deleted in between | No snapshot row for a quiz that could never start |

---

## 11. Results log (fill in while building)

| Step | Date | Result | What bit / notes |
|---|---|---|---|
| WF.0 | 2026-11-24 | ✅ Installed `@mastra/core@1.82.0` + `@mastra/pg@1.35.0` (exact, D1): +143 packages, `node_modules` 209 → 356 MB (`@mastra` alone 106 MB); npm also bumped `pg` 8.23.0 → 8.23.1 (+3 `pg-*` patch versions). `engines` → `">=22.13 <23"` (local Node 22.14.0; both packages need `>=22.13.0`). `MASTRA_TELEMETRY_DISABLED=1` in `.env` + `.env.example`. `db/client.ts` exports `pool`. Checks with a temporary script (deleted afterwards): `npx tsc --noEmit` clean; under `ts-node --transpile-only` AND as compiled CommonJS (`tsc -p tsconfig.build.json`, run with `node`) an in-memory workflow went `start → suspended → resume → success`, and the paused step's `execute` ran **2 times** (re-run from the top, rule 8b). The real `Mastra` + `MastraCompositeStore` + `WorkflowsPG({ pool, schemaName: 'mastra' })` + `logger: false` + `recovery: { workflows: 'off' }` config type-checks. `npm run build` ok; `node dist/index.js` (worker off) → `GET /` 200, `/documents` 401 | **Memory:** loading Mastra takes ~1.4 s; on its own it's 26 → 119 MB RSS, but on top of the app's own modules it adds **~37 MB** (124 → 161 MB: `pg`, `zod` etc. are shared). Render free has 512 MB. **Schema:** `WorkflowsPG`'s storage runs `CREATE SCHEMA IF NOT EXISTS` itself when the schema is missing (`@mastra/pg` dist, `setupSchema`), so no manual `CREATE SCHEMA mastra`; it needs CREATE privilege on the database (Neon's owner role has it), confirmed live in WF.1. **Logger (D7):** the default logger printed only one warning in this test ("No `storage` configured … falling back to an in-memory store"); `logger: false` is accepted by the types → D7 = `logger: false`. **Suspend payload shape:** `start()` returns `suspendPayload` keyed by step id (`{ ask: { question } }`), not the bare payload. **Telemetry:** read in `isTelemetryEnabled()` (`1`/`true`/`yes`) each time it would send, so it must be in the env before Mastra starts (it is: dotenv loads first). **Audit:** 11 vulnerable packages, the same 11 as before the install (ISSUES.md #40) |
| WF.1 | 2026-11-24 | ✅ `src/step8-mastra-poc.ts` + `npm run step8 <mode>` (toy `poc-approval`: `ask` suspends, `finish` ends), real storage = schema `mastra` in the production Neon DB (Shiv's OK). Every mode passed: **start** → `suspended`, `suspendPayload` `{ ask: { question } }`, `suspended` `[["ask"]]`, a 752-byte row; the process exits. **inspect** (new process) → the raw row: `status`, `context.input`, `context.ask.{payload, suspendPayload}`, `suspendedPaths` `{ ask: [0] }`, `serializedStepGraph` … **resume** (another new process) → `ask.execute()` printed "call #1 in THIS process" with `resumeData {approved:true}`, then `finish` ran → `success`, result `{ outcome: 'approved' }`: the state survived the process ending, and the paused step ran again from its first line. **again** on the finished run → throws `WORKFLOW_RUN_NOT_SUSPENDED`, nothing re-ran. **race** → exactly one fulfilled (`success`), the other rejected, `ask` ran once. **cancel** → `canceled`, then resume throws `WORKFLOW_RUN_NOT_SUSPENDED`. **bail** ("no") → status **`success`**, result `{ outcome: 'declined' }`, `finish` never ran (D9 confirmed). **throw** → `start()` does NOT throw to the caller; it returns `failed` with the error (rule 15 confirmed). **crash** → child killed mid-step: stored `running`; a new `off` boot: still `running`; a new `auto` boot + 5 s: **still `running`**; `restartAllActiveWorkflowRuns()` by hand → the 20 s step ran again from line 1 → `success`. **cleanup** → 0 snapshot rows, 0 owner rows | **Tables:** Mastra created schema `mastra` with **two** tables: `mastra_workflow_snapshot` and `mastra_workflow_run_owners` (one "lease" row per run: `runId, generation, ownerId, leaseExpiresAt, updatedAt`). **`deleteWorkflowRunById` deletes the snapshot only; the owner row stays** (checked: 0 snapshot / 1 owner left). Mastra's way to clear them is `workflowsPG.prune({ runOwnership: { maxAge } })` (`retentionTables` in `@mastra/pg`); the PoC deletes its own ids by SQL. WF.3 decides (fix 4 needs it). **Recovery: `'auto'` does nothing in an embedded Mastra.** The boot sweep (`restartAllActiveWorkflowRuns`) is only called by Mastra's own server/deployer (read in `mastra-*.cjs`: "The deployer wires this up automatically"), which DocMind doesn't use. So D5 holds either way; keep `'off'` written down as intent. A hand-called sweep re-runs a paused-mid-step step from line 1 = a second Gemini call in the real workflow (why D5 says off). **Race:** the loser got `WORKFLOW_RUN_NOT_SUSPENDED` (its pre-check already saw `running`), not `…ALREADY_CLAIMED` (only when both pass the pre-check together) → rule 7 now names both. **Latency from this laptop** (Neon is far away: ~250–350 ms per round trip, first connect ~2.7 s): `storage.init()` = 12 queries, **3.3–7.8 s** (7.8 s the first time, creating everything), **0 ms** the second time on the same instance → `getMastra()` must stay a singleton; `start()` ~3 s, `resume()` ~5 s (≥ 6 and ≥ 9 pool queries, plus transactions). On Render, next to Neon, this should be far smaller; WF.7 measures it live. Snapshot of a 2-step paused run: 752 bytes |
| WF.2 | 2026-11-24 | ✅ Shiv ran the §4.4 SQL on Neon (table + partial unique index; `pg_indexes` shows `WHERE (status = ANY (ARRAY['waiting','running']))`). `schema.ts`: `quizWorkflowRuns` (timestamps `withTimezone`) + the SQL in a comment. `quizWorkflowRuns.repository.ts`: `createActiveRun` (insert `running`, `ON CONFLICT DO NOTHING … RETURNING` → a boolean, no 23505 to parse), `findActiveRun(sessionId, userId, staleMs?)` (also returns `expired` / `stale`, computed by Postgres in the same query), `findRunForUser(runId, userId)`, `markWaiting` (only `running` → `waiting`, `expires_at = now() + ttl`), `claimWaitingRun` (one conditional `UPDATE … WHERE status = 'waiting' AND not expired RETURNING`), `markDone`, `listActiveRunsForUser`, `deleteRunsForSession` (returns what it deleted). Every function takes a required `userId`. Temporary in-process test (`src/wf2-test.ts`, deleted after the run), two random user ids, against real Neon: **30/30 passed**: a second active run while the first is `running` and while it's `waiting` → refused; same session id under another user / another chat → allowed; `markWaiting` twice → second false; expiry 30.00 min; user B can't find / claim / mark done / read A's run; **two concurrent claims → exactly one row back**; after the claim `running` + `expires_at` NULL; stale with a 1 s limit, not with 3 min; `done` frees the chat; a 1 s TTL expires and can't be claimed; lists and deletes scoped per user. Cleanup by id: 0 rows left (table empty) | **Added beyond the plan's list:** `findRunForUser` (WF.5's resume route needs 404 "not yours" vs 409 "no longer waiting", and the claim returns null for both), and `QUIZ_RUN_TTL_MS` / `QUIZ_RUN_STALE_MS` in `config.ts` now (the plan listed them under WF.5; the repository's defaults need them). **Time is Postgres's clock everywhere** (`now()` on write and on compare), so Node's clock can't expire a run early. Interval maths uses `$n::float8 * interval '1 millisecond'`: an untyped parameter times an interval can be ambiguous to Postgres. No foreign key to `users` (like every other table), which is also why the test could use made-up user ids |
| WF.3 | 2026-11-24 | ✅ Built `src/mastra/workflows/quiz.workflow.ts` (`quiz-workflow`: `resolve-document` → `ask-user` (suspend `{ question, candidates }`, resume `choose` / `cancel`, picked id checked against the shown list) → `generate-quiz` (the existing `generateQuiz` + 60 s timeout, everything caught into `outcome: 'error'`); `validateInputs`, `autoRestartActiveRuns: false`), `src/mastra/index.ts` (`getMastra()` singleton built on first use, a failed setup isn't cached; `getQuizWorkflow()`), `quizWorkflow.service.ts` (`startQuizRun` → `nothing_ready` / `asked` / `busy` / `ended` / `fallback`; `resumeQuizRun` → 404 / 400 / 409 / the ending; `cancelQuizRun`; `findActiveQuizRun` = pointer + the waiting question from the snapshot), the optional `timeoutMs` in `generateAnswer` + `generateQuiz`, `QUIZ_GENERATE_TIMEOUT_MS`, `listQuizCandidates` + `nothingReadyText` shared from `quizOffer.service.ts`, the `workflow` log theme. A temporary in-process test (deleted) against real Neon + real Mastra storage, Gemini faked by replacing `fetch`: **33/34**: fallback when storage init fails (offer + button, no active row); 0 ready → no run, no rows; one doc → "Want it?"; "quiz me" again while waiting → old run superseded (done + snapshot deleted); All → "Which document?" with the 2 ready (processing left out); user B → 404 and finds nothing; an unshown id → 400 and the run stays waiting; a faked 503 → `error` ending; cancel → `cancelled`; two resumes at once → one quiz, the other 409, **1** Gemini call; a faked hang → `error` after the timeout (67 s from the laptop); document deleted while waiting → "isn't available any more"; expired → 409 + closed; a fresh `running` row → busy, a 4-min-old one → closed and a new run asks; snapshot rows left for all 10 runs: 0. The one failure was the real-Gemini quiz: Gemini answered **503 "high demand"** twice in a row (the step caught it both times and the run ended cleanly). A separate retry script then got a real 5-question quiz through the workflow on the first try (Gemini 2.1 s), snapshot deleted, cleanup 0 rows. `tsc` + `npm run build` ok. Nothing in the app calls the service yet | **A Mastra Workflow is a "thenable":** it has a `.then()` (the step chainer), so returning it from an `async` function makes JavaScript call that `.then()` to unwrap it. TypeScript refused it (TS1058); `getQuizWorkflow()` returns `{ workflow }`. **`AbortSignal.timeout()`'s timer doesn't keep Node alive:** the first test run, with only a hung fake fetch pending, exited silently mid-test with exit code 0 and skipped its cleanup (the leftovers were found by the logged document id and deleted by id, 0 left). A server's HTTP listener keeps it alive; a script needs a keep-alive timer. **Owner rows (WF.1's open point), decided:** `getMastra()` runs `WorkflowsPG.prune({ workflowSnapshot: 1d, runOwnership: 1d })` once per process, fire and forget; the snapshot half is only a safety net (every ending deletes its own snapshot, and nothing legit is a day old). The first prune also lets Mastra add an index on each table's age column. *(§9 said no pruning job was needed; this is a one-line call on setup, not a job.)* **Fallback cost:** if Mastra itself never came up, the fallback skips cleanup (another setup attempt would add seconds before the offer). **Setup from the laptop:** `storage.init()` 3.0–3.3 s on the first quiz of a process. **Mastra calls per run** add up from the laptop (~5–9 s for a start, similar for a resume, cancel + delete ~2 s); WF.7 measures Render |
| WF.4 | 2026-11-25 | ✅ `src/schemas/quizReply.schema.ts` (Zod `QuizReplyLabel` `{ action: choose|cancel|unclear|unrelated, choice }` + the Gemini response schema; `choice` is the document's **number** in the shown list, not its id) and `src/services/quizReply.service.ts`: `readByRules` (the free rules), `buildReplyPrompt`, `interpretQuizReply` (rules → LLM → never throws; returns `{ reading, by: rule|llm|fallback, why, errors }`, the caller logs, like the router) and `askAgainText` (the "ask again" message for `unclear`; documents keep their first-question numbers). Config `QUIZ_REPLY_RULE_MAX_WORDS` (6), `QUIZ_REPLY_TIMEOUT_MS` (15 s). Eval `npm run step8 replies [rules]` (`src/step8-replies.ts`, no DB, no Mastra): **67 labelled replies, 12 traps**, 4 candidate lists (1 doc; 2 React files; 3 different; `lecture-2/1/3` in that order). **Rules took 45, all 45 right, 0 traps.** The LLM got the other 22: **65/67 right, 2 annoying, 0 harmful**, 22 Gemini calls, median 1.2 s, max 2.9 s. Failure paths with a faked `fetch` (temporary script, deleted): 503, network error, not JSON, a bad label, choice 5 of 2, choose without a number, a 15 s hang → all `fallback` + `unclear` with the error returned; a valid label → `choose`. `tsc` + `npm run build` ok. Nothing in the chat calls it yet | **The rules need every word, not just one.** The plan's gate (≤ 6 words, no `?`, no question word first) wasn't enough on its own: "2 examples please" and "give me 2 examples from biology" pass it and contain a number. So every word must be known to the rules (yes/no words, positions, the offered filenames, a short filler list); one unknown word → LLM. **Order of the buckets matters:** no-words, then positions, then yes-words, then fillers, then filenames (so "the" in a filename can't turn "the second one" into a name match). **Numbers inside filenames:** with `lecture-2.pdf` shown first, "2" means position 2 = `lecture-1` but the name says `lecture-2` → `unclear` listing both; an out-of-range number that is a filename word ("2024" with `notes-2024.pdf`) is read as the name. **"don't cancel"** = two no-words meaning *go on* → sent to the LLM (a negator + a stop-word). **LLM failure → `unclear`, not `unrelated`:** asking again keeps the run, nothing is lost and "cancel" still works; `unrelated` would drop the quiz while Gemini is down anyway. **The 2 annoying LLM answers:** "yes but about chapter 2" → `unrelated` (defensible: a topic quiz doesn't exist until 8b) and "don't cancel" → `unrelated` (the run would be dropped and the message answered normally). Left as they are rather than tuning the prompt on the test set |
| WF.5 | | | |
| WF.6 | | | |
| WF.7 | | | |
| WF.8 | | | |

---

## 12. Code facts (what the code looks like today, 2026-11-07, re-checked 2026-11-24)

- `prepareChat` ([chat.service.ts:203](src/services/chat.service.ts#L203)): validate → `checkDocumentReady` for one document (245–252) → **embed (254–262)** → history (268–270) → route (277–290) → smalltalk (294–300) / **quiz offer (307–316, kind `'offer'`)** / agent (320–354). The active-run check goes before line 254.
- *(2026-11-24)* `generateAnswer` ([llm.service.ts:14-33](src/services/llm.service.ts#L14-L33)) throws on any non-OK status and has no timeout. `generateQuiz`'s loop ([quiz.service.ts:154-169](src/services/quiz.service.ts#L154-L169)) retries only an invalid reply, so a 503 leaves it as an exception (fix 1; ISSUES.md #8).
- *(2026-11-24)* `DELETE /documents/:id` ([documents.routes.ts:85-87](src/routes/documents.routes.ts#L85-L87)) deletes the row, then chunks, then that document's messages; nothing quiz-run related yet (fix 4).
- *(2026-11-24)* `sampleChunks` ([chunks.repository.ts:29-53](src/repositories/chunks.repository.ts#L29-L53)) takes evenly spaced chunks across the whole document; there's no topic input (matters for 8b). The chat tool `listDocuments` returns filename, status, chunk count and date, **no id** ([listDocuments.tool.ts](src/tools/listDocuments.tool.ts)); the repository rows do have `id` (used by `buildQuizOffer`).
- Chat routes: `/chat` handles `kind 'offer'` at [chat.routes.ts:64-70](src/routes/chat.routes.ts#L64-L70), `/chat-stream` at [chat.routes.ts:207-216](src/routes/chat.routes.ts#L207-L216) (text frame + `action` event). The stream opens at line 174, after `prepareChat`, so 4xx errors stay plain JSON.
- `buildQuizOffer(userId, one?)` ([quizOffer.service.ts:42](src/services/quizOffer.service.ts#L42)): one doc → `quiz` action; All → 1 ready → `quiz`, several → `quiz_picker`, 0 → text only. No LLM.
- `generateQuiz({ documentId, userId }, t0)` ([quiz.service.ts:101](src/services/quiz.service.ts#L101)): rejects `'all'` (400), `checkDocumentReady` (404/409), `sampleChunks`, structured output, Zod, 2 attempts max (502), shuffle. Never touches `req`/`res`, so a step can call it as-is.
- `db/client.ts`: `const pool = new Pool(...)`, **not exported** (line 8).
- Prompt lines that tell the user to click: [chat.service.ts:104](src/services/chat.service.ts#L104), [agent.service.ts:76](src/services/agent.service.ts#L76).
- Frontend: `handleChatAction` ([App.tsx:230](frontend/src/App.tsx#L230)) → `quiz.generate()` or the picker. `api/chat.ts` `dispatch()` switch at line ~120 (cases meta, message, status, sources, action, done, error; no default). `useQuiz.generate()` always calls `POST /quiz`, so there's no way to show an existing quiz yet.
- Node locally 22.14.0. `package.json` `engines` `"22.x"`. `tsconfig`: `module: commonjs`, no `moduleResolution` (node10 style), `skipLibCheck: true`. TypeScript 5.9.

---

## 13. Research facts + sources (checked 2026-11-07)

Read from the **published packages' own type definitions and compiled source** (`npm pack` into a scratch folder, nothing installed in the repo) and from Mastra's docs. Re-check anything here before relying on it if a lot of time has passed.

**Packages**
- `@mastra/core` **1.82.0**: `engines.node >= 22.13.0`; `"type": "module"`, but `exports` has a `require` entry (`dist/*.cjs`) for `.` and for `./workflows`, so it's **not ESM-only** and CommonJS `require` works. Root-level stub files (`workflows.d.ts` etc.) exist, which should let TypeScript's older `node10` resolution find subpath types (to confirm in WF.0). Peer dependency `zod ^3.25 || ^4`. ~89 MB unpacked. Dependencies include `hono`, `posthog-node`, AI SDK provider packages.
- `@mastra/pg` **1.35.0**: peer `@mastra/core >=1.80 <2`, depends on `pg ^8.23` (DocMind has `^8.23.0`).

**Workflow API (from `dist/workflows/*.d.ts`)**
- `createStep({ id, inputSchema, outputSchema, suspendSchema?, resumeSchema?, execute })`. `execute` receives `inputData, resumeData, suspendData, suspend(payload), bail(result), runId, resourceId, getStepResultAsync, abortSignal, retryCount, …`. Docs pattern: `if (!resumeData) return await suspend({...})`.
- `workflow.createRun({ runId?, resourceId? })`, `run.start({ inputData })`, `run.resume({ step?, resumeData, label? })` (`step` optional when only one step is suspended), `run.cancel()` (sets `canceled` in storage; finished runs unchanged), `workflow.getWorkflowRunById(runId)`, `workflow.listWorkflowRuns({ resourceId?, status?, … })`, `workflow.deleteWorkflowRunById(runId)`.
- Run statuses: `running | success | failed | tripwire | suspended | waiting | pending | canceled | bailed | paused | skipped`. A suspended result has `suspendPayload` and `suspended: string[][]` (the suspended step path).
- **Concurrent resume:** `resume()` claims the run with `updateWorkflowState({ status: 'running', expectedStatus: 'suspended' })`. If that update matches nothing, it throws `MastraError` id **`WORKFLOW_RESUME_ALREADY_CLAIMED`** ("Only one resume() call may continue a given suspension"). `WorkflowsPG.supportsConcurrentUpdates()` returns `true`, so the claim is atomic on Postgres. (Storages without it only log a warning.)
- **Boot recovery:** `MastraRecoveryConfig.workflows: 'auto' | 'off'`, default **`'auto'`**: "Restart RUNNING/WAITING workflow runs found in storage on server boot", 5 at a time.

**Storage**
- `MastraCompositeStore({ id, domains: { workflows: … } })` from `@mastra/core/storage` lets you switch on only the workflows domain. Domains not listed and without a `default` aren't stored.
- `WorkflowsPG(config)` accepts `{ pool }` (an existing `pg.Pool`), `{ client }`, or `{ connectionString }`, plus `schemaName` (default `public`), `skipDefaultIndexes`, `indexes`. Managed table: `mastra_workflow_snapshot` (unique `workflow_name + run_id`). Core also defines `mastra_workflow_run_owners` (run-ownership leases).
- `PostgresStore`/composite stores run `init()` on startup and create their tables + indexes; `disableInit: true` turns that off (then call `init()` yourself). Mastra's bundled Neon doc: "On startup, Mastra calls `storage.init()` and creates its tables and indexes in Neon"; use the **pooled** connection string.

**Telemetry**
- `@mastra/core` sends anonymous events to PostHog (`us.posthog.com`) with OS, Node version and a hashed hostname. It's disabled when `MASTRA_TELEMETRY_DISABLED` is `1`, `true` or `yes` (read in `feature-telemetry-*.cjs`).

**Re-checked 2026-11-10 in the docs bundled inside `@mastra/core` 1.82.0 (`dist/docs/references/*.md`, so they match this exact version):**
- **Recovery config key:** `new Mastra({ recovery: { workflows: 'auto' | 'off', workflowConcurrency, durableAgents } })`; default `{ durableAgents: 'off', workflows: 'auto', workflowConcurrency: 5 }` (`reference-core-mastra-class.md`). Per workflow: `createWorkflow({ options: { autoRestartActiveRuns: false } })` (`reference-workflows-workflow.md`).
- **`bail()`:** "The run itself completes with a **success** status and the bail payload as its result" (`reference-workflows-run.md`). `bailed` is listed as a status, but the run reports `success`.
- **`cancel()`:** works on running and suspended runs; sets `canceled`; "does not wait for running steps to stop"; a running step only stops if it checks `abortSignal`; calling it on a finished run leaves the status unchanged (`reference-workflows-run-methods-cancel.md`).
- **Resume claim:** "Before it runs anything, `resume()` atomically claims the run by moving its stored status from `suspended` to `running`… throws `WORKFLOW_RESUME_ALREADY_CLAIMED` and executes no steps." Enforced only by adapters with `supportsConcurrentUpdates()`, and skipped if `shouldPersistSnapshot` excludes `running`. Over Mastra's own HTTP server a losing resume is a 409 (`reference-workflows-run-methods-resume.md`).
- **Resume with only a runId:** `createRun({ runId })` first, then `resume()`; `step` can be omitted when exactly one step is suspended (`docs-workflows-suspend-and-resume.md`).
- **Resumed step:** the docs' pattern is `if (!resumeData) return await suspend(...)` inside `execute`, i.e. `execute` runs again with `resumeData` set; `suspendData` holds the original suspend payload on resume. WF.1 counts the calls to prove it.
- **Validation:** `options.validateInputs` validates workflow input and resume data; a failure throws instead of starting/resuming.
- **Retries:** per step `retries: n`, per workflow `retryConfig: { attempts, delay }` (`docs-workflows-error-handling.md`). The plan uses neither (generateQuiz retries itself).
- **Snapshot anatomy:** `runId`, `status`, `context` (input + per-step `payload` / `status` / `suspendPayload` / `resumePayload` / `output` / timestamps), `suspendedPaths`, `serializedStepGraph`, `result`, `timestamp` (`docs-workflows-snapshots.md`). The docs call the table `workflow_snapshots`; the Postgres constant is `TABLE_WORKFLOW_SNAPSHOT = "mastra_workflow_snapshot"` (`dist/storage/constants.d.ts`).
- **License:** Apache-2.0 (`@mastra/core` and `@mastra/pg`).

**Verified in WF.0 (2026-11-24, installed packages):** `WorkflowsPG`'s storage creates a missing schema itself (`CREATE SCHEMA IF NOT EXISTS`, needs CREATE privilege); the `./workflows`, `./storage`, `./mastra` subpaths resolve under CommonJS + TS 5.9 (`node10` resolution, `skipLibCheck`); `logger?: TLogger | false`; ~37 MB RSS on top of the app; in-memory suspend → resume works and re-runs the paused step. Details in §11.

**Verified in WF.1 (2026-11-24, live Neon):** resume of a finished or cancelled run throws `WORKFLOW_RUN_NOT_SUSPENDED` and runs nothing; a race loser gets `WORKFLOW_RUN_NOT_SUSPENDED` or `WORKFLOW_RESUME_ALREADY_CLAIMED`; `WorkflowsPG` creates `mastra_workflow_snapshot` **and** `mastra_workflow_run_owners`; `deleteWorkflowRunById` leaves the owner row (cleared by `prune({ runOwnership: { maxAge } })`); `recovery: 'auto'` restarts nothing unless `restartAllActiveWorkflowRuns()` is called (Mastra's server does that, DocMind doesn't); with `logger: false` nothing from Mastra was printed. Details in §11. The local `DATABASE_URL` **is** Neon's pooled endpoint (`-pooler`, PgBouncer in transaction mode), which is what Mastra's Neon doc recommends; every WF.1 mode, including the transactions inside `start`/`resume`, worked through it. (Render's value wasn't checked.)

**Sources**
- [Mastra: Suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume.md)
- [Mastra: Snapshots](https://mastra.ai/docs/workflows/snapshots.md)
- [Mastra: PostgreSQL storage](https://mastra.ai/integrations/databases/postgresql)
- Mastra docs bundled in `@mastra/pg` 1.35.0: `integrations-databases-neon.md`, `reference-storage-composite.md`
- Mastra docs bundled in `@mastra/core` 1.82.0 (`dist/docs/references/`): `docs-workflows-overview.md`, `docs-workflows-suspend-and-resume.md`, `docs-workflows-human-in-the-loop.md`, `docs-workflows-snapshots.md`, `docs-workflows-error-handling.md`, `docs-workflows-control-flow.md`, `reference-workflows-run.md`, `reference-workflows-run-methods-resume.md`, `reference-workflows-run-methods-cancel.md`, `reference-workflows-workflow.md`, `reference-core-mastra-class.md`
- npm registry: `npm view @mastra/core` / `@mastra/pg` (versions, engines, exports, peers); type definitions and compiled source of `@mastra/core@1.82.0` and `@mastra/pg@1.35.0`
