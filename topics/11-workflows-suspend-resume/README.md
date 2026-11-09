# 11 — Workflows (Suspend / Resume), on Mastra

> **Status: 📝 planned, nothing built (2026-11-10).** The build plan is [suspend-resume.md](../../suspend-resume.md) (steps WF.0 → WF.8, decisions D1–D8 still open). Phase 8 will use **Mastra's workflow engine only**, as a library inside the existing Express app. No Mastra agents, tools or server. Every API name on this page was checked against the published `@mastra/core` 1.82.0 and `@mastra/pg` 1.35.0 packages and the docs that ship inside them. Re-check before building if a lot of time has passed, because Mastra releases often.

Today, every DocMind request stands on its own: it comes in, does its work, answers, and the server forgets it. That is fine for "what does section 2 say?". It breaks the moment a task needs **two messages**. "Quiz me" gets an offer, and the user types "yes". But the "yes" arrives in a *new* request, and that request has no idea an offer was ever made. Today the button works around it (the click carries the `documentId`), but typing "yes", "the second one" or "cancel" does nothing useful.

This topic is how real AI backends handle a task that has to **stop, wait for a person, and continue later**, even after a restart, a deploy or a 20-minute pause.

---

## How to read this topic

1. **This file** (15–20 min): the idea, the vocabulary, and where Mastra fits.
2. **[More_on_Workflows.md](More_on_Workflows.md) Part 1, §1–§24** (the concepts, no framework): why a server can't "wait", state machines, saving before replying, double messages, changing the subject, errors, and what a hand-rolled version would look like. Mastra hides these problems. It doesn't remove them, so learn them first.
3. **The same file, Part 2, §25–§45** (Mastra in depth): what Mastra is, where it sits in DocMind, steps, workflows, runs, snapshots, the resume claim, crash recovery, storage, what it doesn't know about, and the quiz workflow traced across three requests.
4. **[suspend-resume.md](../../suspend-resume.md)** last: the build plan for DocMind. It assumes you've read 1–3.

---

## The idea in one picture

```
TODAY (AG.5): the server remembers nothing between messages
  "quiz me"   → offer + [Create quiz] button
  click       → POST /quiz { documentId }       ✓ works: the button carries everything
  "yes"       → router says smalltalk           ✗ the offer is forgotten
  "second one"→ the agent searches "second one" ✗

AFTER (Phase 8): the offer is a paused workflow, saved in Postgres
  "quiz me"   → START a run → step "confirm" calls suspend() → snapshot saved → "Want a quiz on x.pdf?"
                                       ... minutes pass, the server may restart ...
  "yes"       → find this user's waiting run for this chat → RESUME it → generateQuiz() → quiz
```

The run doesn't stay "waiting" in memory. Nothing is running while the user thinks. There is just **a row in a database** that says "this run stopped at step `confirm`, here is everything it knew". Resuming means loading that row and continuing from that step.

---

## What Mastra is (short version)

**Mastra** is an open-source (Apache-2.0) **TypeScript framework for building AI applications**. It covers agents, tools, memory, RAG, evals, a dev server with a UI ("Studio"), deployers, and a **workflow engine**. It's built as a set of npm packages: `@mastra/core` holds the engine, and storage adapters such as `@mastra/pg` (Postgres) are separate packages.

DocMind will use **one piece of it**: the workflow engine plus its Postgres storage. You can think of Mastra here the way you think of Drizzle: a library that does one mechanical job well. Drizzle turns typed calls into SQL. Mastra turns "pause here, continue later" into saved snapshots.

| Mastra has | DocMind uses it? | Why / why not |
|---|---|---|
| Workflows (`createStep`, `createWorkflow`, runs, `suspend`/`resume`) | ✅ **yes** | the whole point of this phase |
| Workflow storage on Postgres (`WorkflowsPG`) | ✅ **yes** | the snapshots must survive a restart; Neon is already there |
| Agents (`new Agent`) | ❌ not now | DocMind's agent (`streamAgent`) stays; maybe a later phase |
| Tools (`createTool`) | ❌ not now | `searchDocuments` / `listDocuments` stay as they are |
| Model providers (AI SDK) | ❌ | Gemini stays on plain `fetch` |
| Memory, RAG, evals | ❌ | DocMind already has its own |
| Server / Studio / deployer | ❌ | Express stays; nothing new on Render |

## Where Mastra fits in DocMind

```
Browser ──► Express ──► requireAuth ──► /chat-stream route ──► prepareChat()
                                                                   │
                         "is there a waiting quiz run for          │   DocMind decides:
                          THIS user in THIS chat?"  ◄──────────────┘   who, which chat, what the reply means
                                   │
                                   ▼
                     quizWorkflow.service.ts   ◄── the ONLY file outside src/mastra/ that imports Mastra
                                   │
                                   ▼
                     src/mastra/  (the Mastra instance + the quiz workflow)
                                   │   Mastra does: step order, suspend, save, load, resume, refuse a double resume
                                   ▼
            steps call EXISTING code:  listDocuments · checkDocumentReady · generateQuiz()
                                   │
                                   ▼
                     Neon Postgres: schema "mastra" (Mastra's snapshot table) + your tables (unchanged)
```

**Mastra orchestrates, DocMind decides.** Mastra never sees a JWT, never checks ownership, never reads a chat message, and never calls Gemini on its own. Steps call the services you already wrote.

## The words you'll need

- **Workflow:** a fixed sequence of steps, defined in code. The model doesn't choose the path (that's what makes it a *workflow* and not an *agent*, see topic 10).
- **Step (`createStep`):** one unit of work with an `id`, Zod `inputSchema` / `outputSchema`, and an `execute` function. Each step's output feeds the next step's input.
- **Run:** one execution of a workflow, with a `runId`. One quiz conversation = one run.
- **Suspend (`suspend(payload)`):** inside a step, "stop here and save". The payload is what the user is being asked about (validated by the step's `suspendSchema`).
- **Resume (`run.resume({ resumeData })`):** "continue that run with this answer" (validated by the step's `resumeSchema`). The paused step's `execute` runs **again from its first line**, this time with `resumeData` filled in.
- **Snapshot:** the run's whole state as JSON (input, each step's status and output, suspend payloads). One row in `mastra_workflow_snapshot`. This row *is* the durability.
- **Human-in-the-loop (HITL):** a step that needs a person (approve, choose, confirm) before it continues. The most common reason to suspend.
- **Durable execution:** a run survives a crash or restart because its state is saved after each step, so it continues instead of starting over.
- **Resume claim:** the one atomic database update that lets exactly one `resume()` continue a suspension. A second one fails with `WORKFLOW_RESUME_ALREADY_CLAIMED`.
- **Pointer table (DocMind's, planned):** `quiz_workflow_runs`, a small table that links `user_id + session_id` to Mastra's `runId`. Mastra knows nothing about users, so *finding* the run, and making sure it's yours, stays in DocMind.

## How a suspend/resume travels (the three requests)

```
REQUEST 1  "quiz me"
  prepareChat → router: quiz_request → start a run
  Mastra: resolve-document (1 ready doc) → confirm: no resumeData yet → suspend({ documentId, filename })
  Mastra saves the snapshot (status 'suspended')     DocMind saves a pointer row (status 'waiting')
  reply: "Want a 5-question quiz on x.pdf?"          ← the request ends; nothing keeps running

  ... 3 minutes. Render may have restarted. Nothing is in memory. ...

REQUEST 2  "yes"
  prepareChat → pointer row for (this user, this session), not expired → reply reader: "confirm"
  Mastra: claim the run (suspended → running, atomic) → load the snapshot
        → run "confirm" again, now with resumeData { action: 'confirm' } → continue
        → generate-quiz → generateQuiz({ documentId, userId })   (re-checks ownership + ready)
  run status 'success', output = the quiz → SSE `quiz` event → the modal opens
```

## How this fits the code you already have

- **The quiz engine doesn't change.** `generateQuiz()` already never touches `req`/`res`, so a workflow step can call it as-is. It's the same reason the BullMQ worker can call `embedAndStoreChunks()`.
- **The offer logic moves, it isn't rewritten.** `buildQuizOffer()`'s "one doc / several / none" decision becomes the first step (`resolve-document`).
- **It reuses the router idea.** The reply reader handles "yes / second one / the React document / cancel" with rules first (free) and an LLM classifier only when unsure. That's the same hybrid as the intent router (topic 10), and the LLM only *labels* the reply.
- **It reuses the auth rules.** The pointer table filters on `user_id AND session_id`, and someone else's run is a 404. `userId` only ever comes from `req.user.id`.
- **It reuses the queue lessons.** "Make the job safe to run twice" (topic 09) becomes "make the step safe to run twice", because a resumed step runs again from the top. "Stalled jobs" become "runs stuck in `running` after a crash".
- **The SSE protocol only grows.** A new `quiz` event and new `action` shapes. `dispatch()` keeps no `default`, so old frontends just skip them.

## Things that will bite you (worth knowing before you hit them)

- **Thinking "suspend" means something is waiting in memory.** It doesn't. The process can die. Only the snapshot row matters.
- **The resumed step runs again from its first line.** Anything before the `if (!resumeData) return suspend(...)` check runs twice. Keep side effects (Gemini calls, writes) *after* it, or in the next step.
- **Two resumes of the same run** (a click plus a typed "yes", a double-click, a retry). Mastra's claim stops the second one with `WORKFLOW_RESUME_ALREADY_CLAIMED`. Treat that as a normal answer ("already being made"), not a 500.
- **Boot recovery is on by default.** `new Mastra({...})` restarts runs left `running` when the server boots. For a step that spends Gemini quota on a quiz nobody is waiting for any more, that's wrong. Plan: `recovery: { workflows: 'off' }`.
- **`cancel()` doesn't stop a step that's already running** unless the step listens to `abortSignal`. `generateQuiz()` doesn't, so cancelling mid-generation only prevents the *next* steps.
- **`bail()` is not an error.** The run ends with status `success`, and the bail payload is the result. Check the output, not only the status.
- **Mastra creates its own tables at startup.** That's the one exception to "every table by hand SQL on Neon" (CLAUDE.md §5). Keep them in a separate Postgres schema (`mastra`).
- **Telemetry is on by default.** `@mastra/core` sends anonymous usage events to PostHog unless `MASTRA_TELEMETRY_DISABLED=1`.
- **Node ≥ 22.13** is required (DocMind's `engines` says `22.x`, local is 22.14). Check what Render runs.
- **It's a big dependency** (~89 MB unpacked) on a 512 MB free server. Measure memory before and after (WF.0).
- **"Yes" three messages later.** If the user changed the subject, a stale offer must not catch a later "yes". The plan cancels on an unrelated message and expires waiting runs after 30 minutes.

## Where this connects

```
06 conversation memory   → chat history is "state in the DB keyed by an id"; a run is the same idea, structured
08 structured output     → suspend/resume payloads are Zod schemas; the reply reader's LLM fallback is JSON + Zod
09 background jobs       → idempotency, stalled work after a crash, "the process can die at any line"
10 agents & tool calling → workflow vs agent; the quiz is a Kind B action; this phase lets a typed "yes" confirm it
11 (here)                → suspend, resume, snapshots, the resume claim, human-in-the-loop, on Mastra
12 testing               → state transitions are pure logic: the easiest thing in an AI backend to test
16 idempotency           → the resume claim is the same family as idempotency keys (do it once, even if asked twice)
```

---

## What you need to learn

- [ ] **Why a server can't "wait" for a reply.** HTTP is request/response, the process restarts, and there may be several instances.
- [ ] **Suspend = save and stop. Resume = load and continue.** Where the state lives, and what has to be in it.
- [ ] **Workflow vs agent vs queue.** Who chooses the path, and what each one is for.
- [ ] **Mastra's building blocks:** step, schemas (input / output / suspend / resume), workflow, run, snapshot, the `Mastra` instance, storage.
- [ ] **What happens inside `resume()`:** the claim, loading the snapshot, re-running the paused step with `resumeData`.
- [ ] **Run statuses and endings:** `success`, `suspended`, `failed`, `canceled`, and why `bail()` reports `success`.
- [ ] **Crash recovery:** what Mastra does with a run left `running`, and why DocMind turns it off.
- [ ] **The boundary:** what Mastra owns (orchestration, state) vs what DocMind owns (identity, ownership, meaning of a reply, SSE).
- [ ] **Human input is messy:** "yes", "2", "the React one", "cancel", and "what's chapter 3 about?", and why the LLM may label a reply but never change state.

## What to build

Full detail, tests and decisions in [suspend-resume.md](../../suspend-resume.md). In short:

**WF.0:** install `@mastra/core` + `@mastra/pg` (exact versions), check that they work in a CommonJS project, turn telemetry off, export the existing `pg` pool.

**WF.1 (the gate):** `npm run step8`, a toy 2-step workflow with no DocMind code. Suspend → exit the process → resume from a *new* process → two resumes at once (exactly one wins) → kill a run mid-step and see what recovery does. Nothing in the chat changes until this passes.

**WF.2 → WF.4:** the pointer table, the real 4-step quiz workflow calling the existing services, and the reply reader with its own labelled eval.

**WF.5 → WF.7:** wire it into `prepareChat` and both chat routes, add the frontend `quiz` event and button resume, then a full test pass and a live check.

**WF.8:** docs.

## Resources

Mastra (read in this order; each is short):
- [Workflows overview](https://mastra.ai/docs/workflows/overview): steps, `createWorkflow`, `.then()`, `.commit()`, running a workflow
- [Suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume): `suspend()`, `resume()`, `suspendData`, finding the suspended step
- [Human-in-the-loop](https://mastra.ai/docs/workflows/human-in-the-loop): suspend payloads as the question for the user, `bail()` for "no"
- [Snapshots](https://mastra.ai/docs/workflows/snapshots): what's saved, the JSON anatomy, "store ids, not big objects"
- [Run.resume() reference](https://mastra.ai/reference/workflows/run-methods/resume): the "Concurrent resume calls" section is the resume claim
- [Run.cancel() reference](https://mastra.ai/reference/workflows/run-methods/cancel): what cancel does and doesn't stop
- [Mastra class reference](https://mastra.ai/reference/core/mastra-class): `storage`, `workflows`, `logger`, and `recovery` (boot-time restarts)
- [PostgreSQL storage](https://mastra.ai/integrations/databases/postgresql): `PostgresStore` / `WorkflowsPG`, `schemaName`, using an existing pool
- [Error handling](https://mastra.ai/docs/workflows/error-handling): `retries` per step, `retryConfig` per workflow

Concept, provider-neutral:
- [Anthropic – Building effective agents](https://www.anthropic.com/engineering/building-effective-agents): "workflows" vs "agents", and why a fixed path is often the better choice
- [LangGraph – Human-in-the-loop / persistence concepts](https://langchain-ai.github.io/langgraph/concepts/persistence/): the same ideas under other names (checkpointer = storage, thread = run, interrupt = suspend). Useful to see the pattern isn't Mastra-specific
- [Temporal docs](https://docs.temporal.io/): the heavy-duty version of the same promise ("durable execution"), for context only

## After you finish

Fill in [NOTES.md](NOTES.md). Be able to explain out loud: (1) what "suspend" actually does when nothing stays in memory, (2) what stops two resumes of the same run from making two quizzes, and (3) why Mastra never decides *whose* run it is. If an interviewer asks "how do you make an AI flow wait for a human?", those three answers are the answer.
