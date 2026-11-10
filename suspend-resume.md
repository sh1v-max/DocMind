# Suspend/Resume Plan: a durable quiz workflow on Mastra (Phase 8)

**Status:** 📝 **plan only, nothing built** (written 2026-11-07, facts re-checked 2026-11-10). No package installed, no code or schema changed. This is Phase 8 of the roadmap (topic [11-workflows-suspend-resume](topics/11-workflows-suspend-resume)). Reading: the topic's [README.md](topics/11-workflows-suspend-resume/README.md) (the short version), then [More_on_Workflows.md](topics/11-workflows-suspend-resume/More_on_Workflows.md) Part 1 §3–§14 (the concepts) and **Part 2 §25–§45 (Mastra in depth: what it is, where it fits, every building block, a run traced across three requests)**. This file is the *build* plan: what changes in DocMind, in which order, and how each step is tested.

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
10. Decisions (open, with recommendations)
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
| WF.0 | Install + compatibility check (CJS, Node, TS, telemetry off) | ⬜ not started | 0.5–1 h |
| WF.1 | **Proof of concept** (`npm run step8`): suspend → persist → kill → resume in a new process → duplicate resume → crash mid-step | ⬜ | 1.5–2 h |
| WF.2 | Pointer table `quiz_workflow_runs` + repository (SQL on Neon by hand) | ⬜ | 1 h |
| WF.3 | The real quiz workflow (steps call the existing services) + in-process tests | ⬜ | 2 h |
| WF.4 | Reply reader ("yes", "second one", "the React document", "cancel") + eval | ⬜ | 2 h |
| WF.5 | Wire into `prepareChat` + both chat routes + the button's resume route | ⬜ | 2–3 h |
| WF.6 | Frontend: `quiz` SSE event opens the modal, the button resumes the same run | ⬜ | 1.5–2 h |
| WF.7 | Full test pass (HTTP, browser, restart, race) + live check on Render/Vercel | ⬜ | 2 h |
| WF.8 | Docs (CLAUDE, README, CODE_EXPLAINED, PROGRESS, walkthrough, roadmap, topic 11 More_on status) | ⬜ | 1–2 h |

Estimates assume Claude writes the code and Shiv reviews. Legend: ⬜ not started · 🟡 in progress · ✅ done (date + one line in §11).

### Before WF.0, Shiv does (outside the code)

- [ ] Answer §10 (D1–D8), or "go with the recommendations".
- [ ] Decide whether the PoC may create Mastra's tables in the **production Neon database** (local `.env` = production, CLAUDE.md §5). The recommendation (D3) keeps them in a separate Postgres schema `mastra`, so they never mix with yours.

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
| **Step** (`createStep`) | One unit of work: an `id`, an `inputSchema` and `outputSchema` (Zod), and an `execute` function | Each stage of the quiz flow (pick a document, confirm, generate) is one step | a service function |
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

---

## 4. Design

### 4.1 Who does what

| Concern | Owner | Where |
|---|---|---|
| Who is asking (JWT) | DocMind | `requireAuth`, `req.user.id` (unchanged) |
| Is this the caller's document? Is it ready? | DocMind | `checkDocumentReady`, `listDocuments` (unchanged, called *from* steps) |
| Generating + validating + shuffling the quiz | DocMind | `generateQuiz()` in `quiz.service.ts` (unchanged, called from the last step) |
| "Is a quiz pending in this chat?" | DocMind | the pointer table `quiz_workflow_runs` (§4.4) |
| What the user's reply means | DocMind | `interpretQuizReply()` (§4.5) |
| When the pending quiz expires, or is dropped because the subject changed | DocMind | pointer table + `prepareChat` |
| SSE events, saved history | DocMind | chat routes (additive changes only) |
| The step order, pausing, saving state, continuing from a fresh process, refusing a double resume | **Mastra** | `src/mastra/` |

**Boundary rule:** only `src/mastra/**` and `src/services/quizWorkflow.service.ts` import Mastra. Everything else calls `quizWorkflow.service.ts`, which returns DocMind-shaped results (`{ ok, ... }`), the same way only `repositories/` touches SQL. Swapping Mastra for a hand-rolled engine later would touch only those files.

### 4.2 The workflow

```
quiz-workflow  (input: { userId, scope: 'one' | 'all', documentId? })

  resolve-document ──(0 ready)──────────────────────────► bail { outcome: 'nothing_ready' }
        │ (exactly 1 candidate)          │ (several)
        │                                ▼
        │                         choose-document ──suspend { candidates[] }──►  ⏸ waits for the user
        │                                │ resume { action:'choose', documentId } │ { action:'cancel' } → bail 'cancelled'
        ▼                                ▼
     confirm ──suspend { documentId, filename }──► ⏸        (skipped when the user just picked one: picking = yes)
        │ resume { action:'confirm' }  │ { action:'cancel' } → bail 'cancelled'
        ▼
  generate-quiz ── generateQuiz({ documentId, userId })  (re-checks ownership + ready: the world may have changed while paused)
        │
        ▼
  output { outcome: 'quiz', documentId, filename, quiz }  |  { outcome: 'error', status, message }
```

- **`resolve-document`** never suspends. One-document chat → that document (already checked by `prepareChat`). "All documents" → the caller's **ready** documents via `listDocuments(userId)` (the same logic as `buildQuizOffer`, moved into a shared helper so it isn't duplicated).
- **`choose-document`** suspends with the **candidate list as it was shown**, so "the second one" means the second one the user saw, not whatever is second now.
- **`confirm`** suspends with the chosen document. If the user has just picked one, it continues without asking (`resumeData` from the previous step says so).
- **`generate-quiz`** calls the existing `generateQuiz()`. That already re-runs `checkDocumentReady` (404 if deleted, 409 if not ready) and retries once. A `502` becomes `{ outcome: 'error' }`, and the run **ends** (D6). Mastra step retries stay **off**, because `generateQuiz` already retries once and more retries would spend free-tier calls.
- **The quiz itself is the run's output**, so it lands in the snapshot (~2–4 KB of JSON). Acceptable. Quizzes still aren't saved anywhere else (same as today).

### 4.3 Storage

```ts
// src/mastra/index.ts (sketch, finalised in WF.0/WF.1)
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
- **A separate Postgres schema `mastra`** (D3): Mastra's tables (`mastra_workflow_snapshot`, plus its run-ownership table) live in `mastra.*`, away from `public.*` where your tables are. Mastra creates them itself when it starts. That's the one exception to "every table by hand SQL" (CLAUDE.md §5), and it gets written down there. WF.0 checks whether it also creates the schema, or whether you run `CREATE SCHEMA mastra` once.
- **Only the workflows domain is switched on**, so no memory, observability, agent or eval tables.
- **Telemetry off:** `@mastra/core` sends anonymous usage events to PostHog unless `MASTRA_TELEMETRY_DISABLED=1` (read in its source, §13). Set it in `.env`, `.env.example` and Render.

### 4.4 Finding the pending run: the pointer table

Mastra finds runs by `runId` (and can list them by `resourceId`/`status`), but the chat only knows `userId` + `sessionId`, and Mastra knows nothing about ownership. So DocMind keeps a small pointer row per quiz run (D2):

```sql
-- WF.2, run by hand on Neon (kept in a comment beside the table in schema.ts)
CREATE TABLE quiz_workflow_runs (
  run_id      text PRIMARY KEY,           -- Mastra's runId (we generate it: randomUUID())
  user_id     text NOT NULL,
  session_id  text NOT NULL,
  status      text NOT NULL,              -- 'waiting' | 'running' | 'done'   (DocMind's view; Mastra's snapshot is the truth for the steps)
  waiting_for text NULL,                  -- 'choose-document' | 'confirm' (which step is suspended)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL        -- now() + 30 min, refreshed on each suspend
);
-- at most ONE waiting quiz per conversation, enforced by Postgres
CREATE UNIQUE INDEX quiz_workflow_runs_one_waiting ON quiz_workflow_runs (user_id, session_id) WHERE status = 'waiting';
```

- **Every query filters `user_id` AND `session_id`** (auth rule), with `userId` a required parameter. Another user's `sessionId` finds nothing.
- **Expiry is lazy:** checked when the row is read. No cron, no BullMQ delayed job.
- **When a new quiz starts while one is waiting:** the old one is cancelled first (pointer → `done`, `run.cancel()`), then the new one starts.
- **Deleting a session** also deletes its pointer rows (one extra line in `DELETE /sessions/:id`). Mastra snapshot rows are left alone (D8).

### 4.5 Reading the user's reply

`interpretQuizReply(message, waitingFor, suspendPayload) → { action: 'confirm' } | { action: 'cancel' } | { action: 'choose', documentId } | { action: 'unclear' } | { action: 'unrelated' }`

Same hybrid idea as the router: **rules first (0 API calls), then the LLM only when unsure.**

| Reply | Rule | Result |
|---|---|---|
| "yes", "sure", "go ahead", "ok do it" | yes-word list, whole message short | `confirm` (only valid while `waitingFor = 'confirm'`) |
| "no", "cancel", "never mind", "stop" | no-word list | `cancel` |
| "2", "second one", "the last one", "first" | number / ordinal against `candidates` | `choose` (out of range → `unclear`) |
| "the React document", "react" | words matched against candidate filenames | exactly one match → `choose`, several → `unclear` (ask again, listing the matches) |
| "what's chapter 3 about?" | none of the above → **LLM** (Flash-Lite, JSON mode, temp 0, Zod, given the candidates with numbers) | usually `unrelated` |

- **`unclear`:** the run stays suspended and the reply asks again ("Which one? 1. react-intro.pdf 2. react-hooks.pdf"). No Mastra call.
- **`unrelated` (D4):** cancel the run (`run.cancel()`, pointer → `done`) and route the message normally, so it gets a normal answer. A "yes" three messages later is ambiguous, and dropping the offer is the safe reading.
- **"yes" while choosing a document** (several candidates) isn't a choice → `unclear` → ask which one.
- The LLM's answer is only a label. Code decides what happens next. The LLM's `documentId` must be one of the candidates (checked in code), otherwise `unclear`.

### 4.6 Where it plugs into the chat

`prepareChat` gets one new step **before the embedding** (today's step 2, [chat.service.ts:254](src/services/chat.service.ts#L254)), so a "yes" costs 0 embedding calls and 0 router calls:

```
validate → (one doc: checkDocumentReady) → NEW: pending = findWaitingQuizRun(sessionId, userId)
   pending, not expired → interpret reply:
       confirm / choose → kind 'workflow', op 'resume'   (the route does the resume, step 7)
       cancel           → kind 'workflow', op 'cancel'
       unclear          → kind 'workflow', op 'ask_again' (no Mastra call)
       unrelated        → cancel the run, then continue below as normal
   expired → pointer 'done' (+ run.cancel()), continue below as normal
   none    → continue below as normal
embed → history → route:
   quiz_request → kind 'workflow', op 'start'   (replaces kind 'offer' / buildQuizOffer)
   smalltalk / document_question → unchanged
```

- **`prepareChat` never runs the workflow itself.** It returns *what to do*, and the route does it at step 7. Starting or resuming can take 5–15 s (quiz generation), and the stream must already be open so the user sees "Writing your quiz…". Services still never touch `res`.
- The user message is saved as today. The assistant reply that's saved is the text the user saw ("Which document? …", "Here's your quiz on **x.pdf**.", "Okay, cancelled.").
- The `"click the Create quiz button"` lines in the smalltalk prompt ([chat.service.ts:104](src/services/chat.service.ts#L104)) and the agent instruction ([agent.service.ts:76](src/services/agent.service.ts#L76)) are removed in WF.5, since typed answers now work.

### 4.7 What the client receives (additive only)

| Channel | Change |
|---|---|
| `/chat-stream` | existing `status` event reused: `{ text: 'Writing your quiz from x.pdf…' }` before generating. **New `quiz` event** `{ runId, documentId, filename, quiz }`. Existing `action` event: buttons now carry the `runId`: `{ type: 'quiz_confirm', runId, documentId, filename }`, `{ type: 'quiz_choose', runId, candidates }` |
| `/chat` JSON | adds `quiz` (same shape) and the new `action` shapes |
| **New** `POST /quiz-runs/:runId/resume` | JSON `{ action: 'confirm' \| 'cancel' \| 'choose', documentId? }` → `{ quiz }` or `{ text }`. What the **buttons** call. Same ownership check (pointer row must be the caller's), same Mastra resume, so a click and a typed "yes" go through **one path** |
| `POST /quiz` | unchanged (the header's "Generate quiz" button still uses it directly; it isn't a conversation) |

The frontend's `dispatch()` has no `default` case, so older bundles skip `quiz` and the new `action` types (CLAUDE.md §9). They'd just show the text.

### 4.8 Failures and races

| Situation | What happens | Who handles it |
|---|---|---|
| Click + typed "yes" at the same moment | One `resume()` claims `suspended → running`. The other gets `WORKFLOW_RESUME_ALREADY_CLAIMED`, mapped to **409** "That quiz is already being made" (button) or a short sentence (chat) | Mastra's claim (verified in source, §13); proven in WF.1 and WF.7 |
| Server restarts while a run is **suspended** | Nothing lost: the snapshot is in Postgres, and the next message resumes it | Mastra storage; proven in WF.1 |
| Server dies **mid-generate** (run left `running`) | Mastra's default boot recovery (`'auto'`) would restart the run with nobody listening, spending a Gemini call on a quiz nobody receives. Plan: recovery **off** (D5), and a pointer stuck `running` for >3 min counts as failed ("That quiz didn't finish, ask again") | DocMind; tested in WF.1 (kill mid-step) |
| Document deleted / not ready while paused | `generateQuiz` → 404/409 → `{ outcome: 'error' }` → "That document isn't available any more" | existing `checkDocumentReady` |
| Gemini fails twice | `generateQuiz` → 502 → run ends → "Couldn't make the quiz right now, say 'quiz me' to try again" (D6) | existing `generateQuiz` |
| Expired (30 min) | Lazy: the next message sees it, cancels it, routes normally | DocMind |
| Another user's `runId` on `/quiz-runs/:id/resume` | **404** (pointer not found for this user). Mastra is never called | DocMind (auth rule: 404 not 403) |
| Mastra/Postgres error | `withErrorHandling` → 503 JSON / `event: error`, and `summarizeError` logs the cause chain | existing error handling |
| "cancel" arrives while `generate-quiz` is already running | `run.cancel()` fires `abortSignal`, but `generateQuiz()` doesn't listen, so the in-flight Gemini call finishes; only later steps are stopped. In practice the pointer is `running`, so the reply reader isn't even consulted: the message is answered as "a quiz is already being made" | Mastra cancel semantics (§13) + DocMind |

---

## 5. Rules to follow while building

1. **Mastra orchestrates, DocMind decides.** Steps *call* existing services (`generateQuiz`, `listDocuments`, `checkDocumentReady`); no business logic is rewritten inside a step.
2. **Only `src/mastra/**` and `quizWorkflow.service.ts` import Mastra.**
3. **No Mastra agents, tools, memory, server or model providers** in this phase. Gemini stays on plain `fetch`.
4. **`userId` only from `req.user.id`**, passed into the workflow input, and re-checked by `checkDocumentReady` inside `generate-quiz`. A run is only ever found through the pointer table, filtered by `user_id` AND `session_id`.
5. **Someone else's run = 404**, the same as a missing one.
6. **The model never changes workflow state.** The LLM fallback only labels a reply; code validates it (candidate ids) and calls `resume`/`cancel`.
7. **Resume is the claim.** Never call `resume()` for a run whose pointer isn't `waiting`, and treat `WORKFLOW_RESUME_ALREADY_CLAIMED` as a normal outcome, not a crash.
8. **Every Mastra result is checked by `status`** (`success` / `suspended` / `failed` / `canceled`); no assumption that `start()` finished. A `bail()` also ends as **`success`** (the bail payload becomes the result), so a `success` is read through the output's `outcome` field (`quiz` / `cancelled` / `nothing_ready` / `error`).
8b. **Nothing with a side effect above the `suspend` check.** A resumed step runs `execute` again from its first line; anything before `if (!resumeData) return suspend(...)` runs twice. Gemini calls and DB writes go below it, or in the next step.
9. **Suspend payloads hold only what the user was shown** (candidate ids + filenames), never chunks, embeddings or quiz text.
10. **SSE changes are additive**, and the frontend's `dispatch()` keeps no `default`.
11. **Re-check the world on resume** (ownership + ready), because time passed while the run was paused.
12. **Logging stays a feature:** every workflow transition logs through `pipelineLogger` (new `workflow` theme), and errors go through `summarizeError`.
13. **Testing against real data:** local `.env` = production Neon. Tests use throwaway guests, delete **only the ids they created** (users, documents, pointer rows, Mastra runs via `deleteWorkflowRunById`), and the PoC uses its own workflow id (`poc-…`).
14. **Telemetry off everywhere** (`MASTRA_TELEMETRY_DISABLED=1`).

---

## 6. Roadmap (build order, with tests)

### WF.0: Install + compatibility check (no app behaviour change)

- `npm install @mastra/core@1.82.0 @mastra/pg@1.35.0` (exact versions, D1). Check what else it pulls in and the `node_modules` size.
- `package.json` `engines.node`: `"22.x"` → `">=22.13 <23"` (Mastra needs ≥ 22.13; check what Render actually runs).
- `.env` / `.env.example` / Render: `MASTRA_TELEMETRY_DISABLED=1`.
- `db/client.ts`: `export const pool` (one line).
- **Checks:** `import { createWorkflow, createStep } from '@mastra/core/workflows'` compiles under your CommonJS `tsconfig` (`npx tsc --noEmit`), runs under `ts-node-dev`, and survives `npm run build && npm start`. Process memory before/after the import (`process.memoryUsage().rss`), since Render free has 512 MB. Find out whether `WorkflowsPG` creates the `mastra` schema itself. (The boot-recovery key is already known: `recovery: { workflows: 'off' }`, §13.)
- **Explain:** what a CJS/ESM dual package is, and why it decides whether this works at all.

### WF.1: Proof of concept: `src/step8-mastra-poc.ts` (`npm run step8 <mode>`) — the gate

A toy 2-step workflow (`poc-approval`): step 1 suspends asking "approve?", step 2 finishes. No DocMind code, no Gemini. Modes:

| Mode | Shows | Pass when |
|---|---|---|
| `start` | create a run, `start()`, print `runId` + the suspended step + payload, **exit the process** | status `suspended`, a row in `mastra.mastra_workflow_snapshot` |
| `inspect <runId>` | `getWorkflowRunById` + the raw snapshot JSON | you can point at the saved suspend payload |
| `resume <runId>` | a **fresh process** rebuilds the run from the id and resumes | status `success`: state survived a restart |
| `race <runId>` | two `resume()` calls at once (`Promise.allSettled`) | exactly 1 fulfilled, 1 rejected with `WORKFLOW_RESUME_ALREADY_CLAIMED` |
| `again <runId>` | resume an already finished run | a clear error, nothing re-runs |
| `crash` | a step that waits 30 s; kill the process mid-step; start again with recovery `off` and `auto` | `off`: run stays `running` (our stale rule handles it). `auto`: Mastra restarts it at boot. Behaviour written down |
| `cancel <runId>` | `run.cancel()` on a suspended run | status `canceled`, and resume is refused |
| (all modes) | a counter inside step 1's `execute`, printed each time it runs | proves the paused step runs **again from its first line** on resume (More_on §32) |
| `bail` | a variant where the resume answer is "no" and the step calls `bail()` | run status `success`, result = the bail payload (so `outcome` is what matters) |
| `cleanup` | delete every `poc-approval` run | 0 rows left |

**Explain while building:** what's inside a snapshot, where `suspend()` returns to, why the second process can continue, how the claim works (one conditional UPDATE), and why recovery-on-boot is risky for a step that spends money.

**Shiv reviews the output. Nothing in the chat changes until this passes.**

### WF.2: Pointer table + repository

SQL from §4.4 run on Neon by Shiv, the table added to `schema.ts` with the SQL in a comment, and `quizWorkflowRuns.repository.ts` with `createWaitingRun`, `findWaitingRun(sessionId, userId)`, `markRunning` / `markWaiting` / `markDone(runId, userId)`, `deleteRunsForSession`. Every function takes a required `userId`. **Test:** in-process, two guests, one waiting run per session (a second insert hits the unique index), expiry check, cleanup by id.

### WF.3: The real quiz workflow

`src/mastra/workflows/quiz.workflow.ts` (4 steps, §4.2), `src/mastra/index.ts` (§4.3), and `quizWorkflow.service.ts` (`startQuizRun`, `resumeQuizRun`, `cancelQuizRun`, each returning DocMind-shaped results and updating the pointer). **Tests (in-process, real Neon, throwaway guest + small PDF):** one doc → suspends at `confirm` → resume confirm → real quiz; All with 2 ready → `choose-document` → choose → quiz without a confirm; cancel at each step; document deleted while paused → error outcome; 0 ready → `nothing_ready`. One run with a fake `generateQuiz` to keep Gemini calls down.

### WF.4: Reply reader

`src/services/quizReply.service.ts` + `src/schemas/quizReply.schema.ts` (Zod + Gemini response schema), and an eval in `step8 replies`: ~35 labelled replies ("yes", "yep go", "2", "second one", "the last one", "react", "the React document" with 2 React files, "cancel", "nah", "what's in chapter 3?", "yes but about chapter 2", …). **Pass:** 0 harmful mistakes (a cancel read as confirm, a wrong document chosen), LLM used only on the unclear ones. The LLM count gets written down.

### WF.5: Chat + routes

`prepareChat` kind `'workflow'` (§4.6), both chat routes run the op at step 7 with a `status` event + the `quiz` event (§4.7), `POST /quiz-runs/:runId/resume` (new `quizRuns.routes.ts`, behind `requireAuth` like every data route), `DELETE /sessions/:id` also deletes pointer rows, prompt lines removed, `pipelineLogger` `workflow` theme. **Tests (HTTP, local server):** the §8 list.

### WF.6: Frontend

`types/chat.ts` (new action shapes + `quiz` payload), `api/chat.ts` (`quiz` case), `useChat` (`onQuiz`), `useQuiz.show(quiz, filename)` (open the modal with a quiz that already exists; "Regenerate" still uses `POST /quiz`), `ChatTurn` buttons → `POST /quiz-runs/:runId/resume`, and the picker as numbered buttons. **Tests:** headless Chromium: type "quiz me" → "yes" → the modal opens; All docs → "the second one" → modal; click and type at once → one quiz; reload while waiting → typing "yes" still works (state is on the server); light/dark/375 px; 0 console errors.

### WF.7: Full pass + live

The whole §8 checklist again on a local server, then a restart test (suspend → restart the server → resume), then deploy (Render: `MASTRA_TELEMETRY_DISABLED`, Node version, memory in Render's metrics) and a live check with throwaway guests deleted by id afterwards.

### WF.8: Docs

CLAUDE.md (§3, §4 stack row, §5 env + the Mastra-tables exception, §6 layout, §7 API + SSE, §8 data model, §9 gotchas, §13), README (stack table, API, SSE table, decisions, limitations), CODE_EXPLAINED (Phase 8 section with line links), PROGRESS (topic 11 ✅), walkthrough + roadmap (how it turned out), topic 11 README + More_on (status lines, "planned" → what actually happened, a Part 3 like topic 10's), `topics/OVERVIEW.md`, ISSUES.md for anything found. Topic 11 NOTES.md stays Shiv's.

**Already written before the build (2026-11-10, at Shiv's request):** topic 11 [README.md](topics/11-workflows-suspend-resume/README.md) (new), More_on Part 2 (§25–§45, Mastra in depth) + Part 1 refreshed, and "planned on Mastra" notes in PROGRESS, the roadmap, the walkthrough, README, OVERVIEW and CLAUDE.md. WF.8 turns those "planned" notes into "built" ones.

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
| `src/mastra/index.ts` | new: `Mastra` instance + storage | WF.3 |
| `src/mastra/workflows/quiz.workflow.ts` | new: 4 steps + the workflow | WF.3 |
| `src/services/quizWorkflow.service.ts` | new: start/resume/cancel/find, the only Mastra caller outside `src/mastra` | WF.3 |
| `src/services/quizOffer.service.ts` | candidate logic shared with `resolve-document`; the template texts move into the workflow's replies | WF.3/5 |
| `src/services/quizReply.service.ts`, `src/schemas/quizReply.schema.ts` | new | WF.4 |
| `src/services/chat.service.ts` | pending-run check before embedding, kind `'workflow'`, prompt line removed | WF.5 |
| `src/services/agent.service.ts` | the "click the Create quiz button" line removed | WF.5 |
| `src/routes/chat.routes.ts` | step 7 for kind `'workflow'`, `status` + `quiz` events | WF.5 |
| `src/routes/quizRuns.routes.ts` + `app.ts` mount | new: `POST /quiz-runs/:runId/resume` | WF.5 |
| `src/routes/sessions.routes.ts` | delete pointer rows with the session | WF.5 |
| `src/utils/pipelineLogger.ts` | `workflow` theme | WF.5 |
| `src/config.ts` | `QUIZ_RUN_TTL_MS` (30 min), `QUIZ_RUN_STALE_MS` (3 min) | WF.5 |
| `frontend/src/types/chat.ts`, `api/chat.ts`, `api/quizRuns.ts` (new), `hooks/useChat.ts`, `hooks/useQuiz.ts`, `components/chat/ChatTurn.tsx`, `App.tsx` | §WF.6 | WF.6 |
| docs | §WF.8 | WF.8 |

**Not touched:** `llm.service.ts`, `agent.service.ts` (except one prompt line), `router.service.ts`, `src/tools/*`, `quiz.service.ts`, `quiz.routes.ts`, every other repository, auth, the queue and worker.

---

## 8. Test checklist

**PoC (WF.1):** suspend → exit → resume in a new process ✓ · duplicate resume → exactly one wins ✓ · resume a finished run → refused ✓ · cancel then resume → refused ✓ · kill mid-step with recovery off/auto → behaviour recorded ✓ · cleanup leaves 0 rows ✓

**Chat (WF.5–WF.7):**
- [ ] One-doc chat: "quiz me" → offer (suspended at confirm) → "yes" → quiz event, modal data valid (5 × 4, shuffled)
- [ ] One-doc: "quiz me" → "no thanks" → cancelled, pointer `done`, Mastra status `canceled`
- [ ] All, 2 ready: "quiz me" → list → "the second one" → quiz from document #2
- [ ] All, 2 ready: "the React document" with one React file → that one; with two → asks again, still waiting
- [ ] All: "yes" while choosing → asks which one
- [ ] All, 1 ready → straight to confirm; 0 ready → sentence, **no run created**
- [ ] Waiting, then an unrelated question → normal agent answer + run cancelled
- [ ] Waiting 31 min (or TTL lowered in the test) → expired, message routed normally
- [ ] Click **Create quiz** + type "yes" at the same time → one quiz, the other gets 409 / "already being made"
- [ ] Restart the server while waiting → "yes" still works
- [ ] Document deleted while waiting → "isn't available any more", no Gemini call
- [ ] Guest B: `POST /quiz-runs/<A's runId>/resume` → 404; B's chat with A's `sessionId` finds no pending run
- [ ] `DELETE /sessions/:id` removes its pointer rows
- [ ] Old frontend bundle (via `git archive`, like AG.4) still works: text shown, no crash
- [ ] Log: every transition visible with the `workflow` theme; Gemini calls counted (reply reader: 0 on rule matches)
- [ ] Live: same core flow on Render + Vercel; memory within limits; test data deleted by id

---

## 9. What this phase deliberately does NOT cover

- Mastra `createTool()`, a Mastra quiz agent, agents/tools inside workflows (Phase 2 of the brief, later). **Agreed 2026-11-10 as "Phase 8b", after WF.7, not planned in detail yet:** (a) rebuild the existing document-chat agent in Mastra (same two tools via `createTool`, same system instruction) as a script (`npm run step9`, not a route) and run it on the same 9-question set the custom agent scored 9/9 on, to compare code size, model calls, answers and what the framework hides; (b) a small quiz agent with `listDocuments` (Kind A) and `createQuiz` with `requireApproval: true` (reuses `generateQuiz()`), to compare the agent's tool-approval pause with the workflow's `suspend()`. Kept out of the live chat at first: two "wait for yes" mechanisms live at once would fight over a typed "yes". Verified in the 1.82.0 bundled docs: `requireApproval` / `requireToolApproval`, the `tool-call-approval` stream chunk + `approveToolCall()` / `declineToolCall()` (needs storage), and Gemini via a `'google/…'` model string reading `GOOGLE_GENERATIVE_AI_API_KEY` (no provider package).
- Mastra's server, playground (`mastra dev`), deployer, memory, observability, evals.
- Moving `streamAgent`, the router or the tools to Mastra.
- Saving quizzes or answers (still not persisted; a reload loses an open quiz, as today).
- Quiz options (question count, difficulty, chapters). The schema is fixed at 5 × 4, and chunks have no chapters.
- Workflows for anything other than the quiz.
- A hand-rolled version or LangGraph.js. More_on §15–§16 cover the comparison, and the PoC's `inspect` mode shows what a hand-rolled `state jsonb` would hold.
- Pruning old Mastra snapshot rows (D8; it has a `retention` option for later).

---

## 10. Decisions (open, with recommendations)

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | Version pinning | **Exact** `1.82.0` / `1.35.0` | Mastra ships very often (core is at 1.82). A surprise minor version mid-build would make results hard to compare |
| D2 | How to find the pending run for a chat | **DocMind pointer table** (§4.4). Alternative: Mastra `resourceId = "<userId>:<sessionId>"` + `listWorkflowRuns({ resourceId, status: 'suspended' })`, no new table | Ownership, expiry and "one per session" stay in your code and your SQL (constraint 9), and you can query it without parsing Mastra's JSON |
| D3 | Where Mastra's tables go | **Postgres schema `mastra`** in the same Neon DB, sharing your pool | Kept apart from your tables, no extra connections, no new service |
| D4 | Unrelated message while waiting | **Cancel the run** and answer normally | A "yes" several messages later is ambiguous |
| D5 | Mastra boot recovery for `running` runs | **Off**, plus our 3-min stale rule | Auto would restart a quiz generation nobody is waiting for and spend Gemini calls |
| D6 | Quiz generation fails twice | **End the run** with an error reply ("say 'quiz me' to try again") | Simple. Re-suspending a failed run needs time-travel/restart APIs that aren't worth learning yet |
| D7 | Mastra's own logger | **Off** (`logger: false`) or warn-level, decided in WF.0 after seeing its output | `pipelineLogger` is the project's log, and two loggers interleaving is noise |
| D8 | Old snapshot rows | **Keep for now** (inspectable while learning). The test cleanup deletes its own | Pruning can come later with Mastra's `retention` option |

---

## 11. Results log (fill in while building)

| Step | Date | Result | What bit / notes |
|---|---|---|---|
| WF.0 | | | |
| WF.1 | | | |
| WF.2 | | | |
| WF.3 | | | |
| WF.4 | | | |
| WF.5 | | | |
| WF.6 | | | |
| WF.7 | | | |
| WF.8 | | | |

---

## 12. Code facts (what the code looks like today, 2026-11-07)

- `prepareChat` ([chat.service.ts:203](src/services/chat.service.ts#L203)): validate → `checkDocumentReady` for one document (245–252) → **embed (254–262)** → history (268–270) → route (277–290) → smalltalk (294–300) / **quiz offer (307–316, kind `'offer'`)** / agent (320–354). The pending-run check goes before line 254.
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

**Not yet verified (WF.0/WF.1 will):** whether `WorkflowsPG` creates the `mastra` schema itself; whether TS 5.9 type-checks its `.d.ts` cleanly under `node10` resolution; memory added at runtime; behaviour on Neon's pooled endpoint; what Mastra's default logger prints and whether `logger: false` is accepted; what `resume()` does on a finished or cancelled run.

**Sources**
- [Mastra: Suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume.md)
- [Mastra: Snapshots](https://mastra.ai/docs/workflows/snapshots.md)
- [Mastra: PostgreSQL storage](https://mastra.ai/integrations/databases/postgresql)
- Mastra docs bundled in `@mastra/pg` 1.35.0: `integrations-databases-neon.md`, `reference-storage-composite.md`
- Mastra docs bundled in `@mastra/core` 1.82.0 (`dist/docs/references/`): `docs-workflows-overview.md`, `docs-workflows-suspend-and-resume.md`, `docs-workflows-human-in-the-loop.md`, `docs-workflows-snapshots.md`, `docs-workflows-error-handling.md`, `docs-workflows-control-flow.md`, `reference-workflows-run.md`, `reference-workflows-run-methods-resume.md`, `reference-workflows-run-methods-cancel.md`, `reference-workflows-workflow.md`, `reference-core-mastra-class.md`
- npm registry: `npm view @mastra/core` / `@mastra/pg` (versions, engines, exports, peers); type definitions and compiled source of `@mastra/core@1.82.0` and `@mastra/pg@1.35.0`
