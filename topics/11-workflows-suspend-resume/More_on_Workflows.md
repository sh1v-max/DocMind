# 11 — Workflows (Suspend / Resume)

**Roadmap: Phase 8** · **Status in DocMind: 📝 planned on Mastra, nothing built yet (2026-11-10).** Build plan: [suspend-resume.md](../../suspend-resume.md). Short intro: [README.md](README.md).

This file has two parts:

- **Part 1 (§1–§24): the concepts, with no framework.** What a workflow is, why a server can't wait, state machines, the rules that make suspend/resume correct, double messages, human input, errors, and what you'd write by hand. Written 2026-10-01, before the Mastra decision. It's still the foundation: Mastra hides these problems, it doesn't remove them.
- **Part 2 (§25–§45): Mastra, the engine DocMind will use.** What Mastra is, where it sits in DocMind, every building block with code, a run traced across three requests, snapshots, the resume claim, crash recovery, storage, the boundary with DocMind, the planned quiz workflow, what bites, and interview answers. Every API name was checked against the published `@mastra/core` **1.82.0** / `@mastra/pg` **1.35.0** packages (their type definitions, compiled source, and the docs bundled inside them) on 2026-11-07/10. Mastra ships often, so re-check before building if months have passed.

**Plan change, 2026-11-07:** the roadmap's original Phase 8 was "hand-roll a `workflow_runs` table (8.2), then optionally redo it in LangGraph.js (8.3)". Shiv chose **Mastra workflows** instead, used only as an engine inside Express. §8 (hand-rolled) and §16 (LangGraph) stay as concept material, because they show what any engine does underneath. Why Mastra: §26.

Code this file talks about: [quiz.service.ts](../../src/services/quiz.service.ts) (`generateQuiz`), [quizOffer.service.ts](../../src/services/quizOffer.service.ts) (`buildQuizOffer`), [chat.service.ts](../../src/services/chat.service.ts) (`prepareChat`), [chat.routes.ts](../../src/routes/chat.routes.ts), [db/client.ts](../../src/db/client.ts), [schema.ts](../../src/db/schema.ts)

---

# Part 1 — The Concepts (no framework)

# 1. What is a Workflow?

A workflow is a task that takes **more than one step**, where the steps happen **across more than one request**.

Today every DocMind request is self-contained:

```text
request in → do everything → response out → forget
```

Now imagine quiz creation as a conversation:

```text
user:  "quiz me"
bot:   "Sure. How many questions, and should I cover the whole document?"
                                   ← the server must REMEMBER it asked this
user:  "5, whole thing"
bot:   "5 questions on the whole document. Go ahead?"
                                   ← and remember the answers so far
user:  "yes"
bot:   [creates the quiz]
```

Three HTTP requests. One task. Something has to hold the task together in between.

---

# 2. Simple Analogy

A government form with a waiting step.

```text
Day 1:  fill the form → submit → "come back with your ID proof"
        (clerk puts your file in a cabinet, labelled with your token number)

Day 4:  you return with the token → clerk pulls YOUR file
        → sees you're at step 2 → continues from there
```

* The **file in the cabinet** = saved state
* The **token number** = the id used to find it (`sessionId`)
* "Come back later" = **suspend**
* Pulling the file and continuing = **resume**

The clerk on day 4 might be a different person (a different server instance, after a restart). It doesn't matter, because everything needed is in the file. Nothing is in anyone's head.

---

# 3. Why the Server Can't Just "Wait"

A natural first idea:

```ts
const answer = await waitForUserReply()   // ← this does not exist
```

It can't, because:

* **HTTP is request/response.** The request that asked the question has already ended.
* **The server may restart** between messages (deploy, crash, free-tier spin-down).
* **There may be several instances.** The reply could land on a different one.
* **The user may come back in an hour.** Or never.

So "waiting" has to be faked:

> **Suspend = write down where you are and stop. Resume = read it back and continue.**

Nothing is actually paused. There's just a row in a database.

---

# 4. The Mental Model: A State Machine

A workflow is:

```text
STEPS      named points in the process          (proposeScope, awaitConfirmation, createQuiz)
STATE      the data collected so far            ({ documentId, questionCount: 5 })
STATUS     where the whole run stands           (ACTIVE, SUSPENDED, COMPLETED, FAILED)
TRANSITIONS  rules for moving between steps     (confirmed → createQuiz, rejected → cancel)
```

```text
              start
                │
                ▼
        ┌───────────────┐
        │ proposeScope  │   ACTIVE
        └───────────────┘
                │ asks the user, saves state
                ▼
        ┌───────────────────┐
        │ awaitConfirmation │   SUSPENDED   ← nothing is running here
        └───────────────────┘
          │ "yes"        │ "no" / something else
          ▼              ▼
   ┌────────────┐   ┌───────────┐
   │ createQuiz │   │ cancelled │   COMPLETED
   └────────────┘   └───────────┘
     │        │
     ▼        ▼
 COMPLETED  FAILED
```

The four statuses:

| Status | Meaning |
|---|---|
| `ACTIVE` | code is running a step right now |
| `SUSPENDED` | waiting for outside input; nothing is running |
| `COMPLETED` | finished (successfully or cancelled) |
| `FAILED` | a step threw and wasn't recovered |

---

# 5. You've Already Built Half of This

Conversation memory in DocMind works like this: there's **no `sessions` table**; a session is a `session_id` shared by `chat_messages` rows, and history is replayed into each prompt.

That's already "state in the database, keyed by an id, reloaded on every request".

A workflow run is the same idea with a different kind of state:

```text
chat memory    → sessionId → the MESSAGES so far      (unstructured)
workflow run   → sessionId → the STEP + DATA so far   (structured)
```

---

# 6. The `workflow_runs` Table

```sql
CREATE TABLE workflow_runs (
  id            text PRIMARY KEY,          -- uuid
  session_id    text NOT NULL,
  workflow      text NOT NULL,             -- 'create_quiz'
  current_step  text NOT NULL,             -- 'awaitConfirmation'
  state         jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL,             -- ACTIVE | SUSPENDED | COMPLETED | FAILED
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_runs_session_status ON workflow_runs (session_id, status);
```

Why `jsonb` for `state`? Different workflows collect different data. A JSON column lets one table serve them all. The tradeoff is the database no longer checks the shape, so **validate it with Zod when you read it** (it's another untrusted input: old rows may have an old shape).

In the repo this would be a new table in [schema.ts](../../src/db/schema.ts) with the SQL kept in a comment beside it (the existing convention), and a new `workflowRuns.repository.ts`. Nothing else touches SQL.

---

# 7. The Message Handler With Workflows

Every incoming message now starts with one question:

```text
                    message arrives (sessionId)
                              │
                              ▼
        is there a SUSPENDED run for this session?
              │                        │
             yes                       no
              │                        │
              ▼                        ▼
     resume(run, message)        normal routing
              │                  (smalltalk / RAG / start a workflow)
              ▼
     step logic → save → reply
```

In code shape:

```ts
const run = await findSuspendedRun(sessionId)
if (run) return resumeWorkflow(run, message)
return routeNormally(message)        // may START a workflow
```

This check goes at the very top of the chat pipeline, before embedding or searching. A "yes" should never be sent to vector search.

---

# 8. Building It by Hand (what any engine does underneath)

> DocMind won't ship this version (Phase 8 uses Mastra, Part 2). It's here because it is the clearest way to see what a workflow engine actually does. Mastra's `createStep` / `suspend` / snapshot table are this same idea, written by someone else and hardened.

A small, honest implementation: each step is a function that takes the state and the user's input, and returns the next step, new state, new status, and a reply.

```ts
type StepResult = {
  nextStep: string
  state: QuizWorkflowState
  status: 'SUSPENDED' | 'COMPLETED' | 'FAILED'
  reply: string
}

const steps = {
  // Step 1 — propose and stop
  async proposeScope(state): Promise<StepResult> {
    return {
      nextStep: 'awaitConfirmation',
      state,
      status: 'SUSPENDED',
      reply: `I'll make 5 questions covering the whole document. Go ahead?`,
    }
  },

  // Step 2 — runs on the NEXT message
  async awaitConfirmation(state, userMessage): Promise<StepResult> {
    const decision = await classifyConfirmation(userMessage)   // 'confirm' | 'reject' | 'other'

    if (decision === 'reject') {
      return { nextStep: 'done', state, status: 'COMPLETED', reply: 'No problem, cancelled.' }
    }
    if (decision === 'other') {
      // user changed the subject: see §12
      return { nextStep: 'done', state, status: 'COMPLETED', reply: '' }
    }

    const result = await generateQuiz({ documentId: state.documentId }, Date.now())
    if (!result.ok) {
      return { nextStep: 'done', state, status: 'FAILED', reply: result.error }
    }
    return {
      nextStep: 'done',
      state: { ...state, quiz: result.quiz },
      status: 'COMPLETED',
      reply: 'Your quiz is ready.',
    }
  },
}
```

And a tiny engine around it:

```ts
async function runStep(run: WorkflowRun, userMessage?: string) {
  const result = await steps[run.currentStep](run.state, userMessage)
  await saveRun(run.id, result.nextStep, result.state, result.status)   // persist BEFORE replying
  return result.reply
}
```

Notice `createQuiz` is `generateQuiz()`, the function that already exists. It never touches `req`/`res`, which is why a workflow can call it. Same reason a worker could.

---

# 9. The Rules That Make It Correct

**1. Save after every step, before replying.**

```text
✓ do step → save state → send reply
✗ do step → send reply → save state     (crash in between = user saw a question the server doesn't remember asking)
```

**2. Everything in `state` must be serializable.**

Plain JSON only: strings, numbers, arrays, objects. No functions, class instances, `Date` objects (store ISO strings), sockets, or promises. If it can't survive `JSON.parse(JSON.stringify(x))`, it can't be suspended.

**3. Don't keep anything in memory between requests.**

A `Map<sessionId, state>` in the server works on your laptop and breaks on the first restart. Render's free tier restarts and spins down constantly.

**4. Store ids, not copies.**

`{ documentId }`, not the document's text. The document could be deleted while the run is suspended, which leads to rule 5.

**5. Re-validate on resume.**

The world may have changed while you were suspended: the document was deleted, the session was deleted. Check before acting.

**6. One active run per session.**

Decide what happens if the user starts a second workflow while one is suspended. Simplest: cancel the old one. A partial unique index enforces it at the DB level:

```sql
CREATE UNIQUE INDEX one_open_run_per_session
  ON workflow_runs (session_id) WHERE status IN ('ACTIVE', 'SUSPENDED');
```

---

# 10. Double Messages (a Race Condition)

The user double-clicks send, or the client retries. Two requests arrive with "yes" for the same suspended run:

```text
request A: loads run (SUSPENDED) → generates a quiz
request B: loads run (SUSPENDED) → generates a quiz     ← two quizzes
```

The fix is to **claim** the run atomically:

```sql
UPDATE workflow_runs
SET status = 'ACTIVE', updated_at = now()
WHERE id = $1 AND status = 'SUSPENDED'
RETURNING *;
```

Only one request gets a row back. The other sees zero rows and backs off. This is **optimistic locking**, and it's the same family of problem as idempotency in [topic 16](../16-idempotency-multi-tenancy/More_on_Idempotency_Multi_Tenancy.md).

It also has a failure case of its own: a run stuck in `ACTIVE` forever because the process died mid-step. A timeout (treat `ACTIVE` older than N minutes as stalled) handles that. Same idea as BullMQ's stalled jobs.

---

# 11. Human-in-the-Loop

The most common reason to suspend is a person:

```text
approval       "Go ahead and create this?"            ← Step 7.4's Kind-B confirmation
missing info   "Which chapters?"
choice         "Option A or B?"
review         "Here's the draft, edit before I send"
```

This is why topics 10 and 11 connect. A Kind-B tool (the model must not call it itself) needs a human "yes", and waiting for that "yes" is a suspended workflow.

Other things a workflow can wait on, with the same mechanism:

* a background job finishing (topic 09)
* a webhook from a payment provider
* a timer ("remind in 24 hours")

---

# 12. When the User Changes the Subject

```text
bot:   "5 questions on the whole document. Go ahead?"
user:  "wait, what does chapter 3 say about pricing?"
```

That's not yes and not no. Options:

| Policy | Behaviour |
|---|---|
| **Cancel and answer** | drop the workflow, treat the message normally (simplest, least surprising) |
| Answer and stay suspended | answer the question, then re-ask the confirmation |
| Insist | "Please answer yes or no" (annoying) |

Whatever you pick, the classifier needs three outputs (`confirm | reject | other`), not two. Treating everything that isn't "yes" as "no" is fine; treating everything that isn't "no" as "yes" is a bug that creates quizzes nobody asked for.

Also add **expiry**: a run suspended for a day shouldn't hijack tomorrow's first message. Check `updated_at` on load and ignore stale runs.

---

# 13. Errors Inside a Workflow

```text
step throws
   ├─ transient (Gemini 503)  → retry the STEP (not the whole workflow)
   └─ permanent               → status FAILED, tell the user, keep the state for debugging
```

Because state is saved after each step, a retry re-runs only the failed step. Completed steps aren't repeated. That property is called **durable execution**, and it's the main selling point of workflow engines.

It only works if steps are **idempotent**: a step that ran halfway and gets retried must not double its side effects. Again.

Bigger systems add **compensation** (the "saga" pattern): if step 3 fails after step 2 charged a card, run an "undo" for step 2. DocMind doesn't need it.

---

# 14. What Does `/chat-stream` Do During a Workflow?

The existing SSE protocol is `meta → text pieces → done`. A workflow reply is usually a short fixed string or a non-text result.

Options:

* **Send workflow replies through the same protocol**: one `data: { text }` frame, then `done`. No frontend change. Good enough for "Go ahead?".
* **A new named event** for non-text results, e.g. `event: quiz` with the quiz JSON, so the frontend can open `QuizModal`.
* **Include workflow status in `meta`** (`{ sessionId, sources: [], workflow: { status: 'SUSPENDED' } }`) so the UI could render Yes/No buttons instead of making the user type.

Buttons are worth it: a button sends an exact value, so you don't need an LLM to interpret "yeah sure go for it".

Remember the frontend depends on the SSE protocol exactly. Any new event needs matching frontend code.

**What the plan picks (§42):** both. The question goes out as normal text frames, a new named `quiz` event carries the finished quiz, and the existing `action` event carries buttons that now include the `runId`. A click and a typed "yes" resume **the same run through the same code**, so there's one path to test.

---

# 15. Hand-Rolled vs a Framework

What you wrote by hand in §8 is, in miniature, what workflow libraries do:

| You wrote | LangGraph calls it | Mastra calls it (Part 2) |
|---|---|---|
| `steps` object | nodes | steps (`createStep`) |
| `nextStep` | edges / conditional edges | `.then()` / `.branch()` chain |
| `state` jsonb | graph state | each step's input/output (+ optional workflow `state`) |
| `workflow_runs` table | checkpointer | storage → `mastra_workflow_snapshot` |
| one row | checkpoint | snapshot |
| `sessionId` lookup | thread id | `runId` (+ `resourceId`); DocMind adds a pointer table |
| returning `SUSPENDED` | `interrupt()` | `suspend(payload)` |
| loading and continuing | `Command({ resume })` | `run.resume({ resumeData })` |
| the conditional `UPDATE … WHERE status='SUSPENDED'` | — | the resume claim (built in, §33) |

That mapping is the reason to understand the hand-built version first. After it, a framework is vocabulary, not magic.

---

# 16. LangGraph.js in One Page (the alternative, not used)

> The roadmap's optional Step 8.3. DocMind uses Mastra instead (§26 says why). It's kept because LangGraph is the name interviewers say most often, and its ideas map one-to-one onto Mastra's (table in §15).

LangGraph models a workflow as a **graph**: nodes are functions that read and update a shared state; edges say what runs next.

Conceptual shape:

```ts
import { StateGraph, Annotation, START, END, interrupt, Command, MemorySaver } from '@langchain/langgraph'

// 1. The state
const State = Annotation.Root({
  documentId: Annotation<string>(),
  confirmed: Annotation<boolean>(),
  quiz: Annotation<unknown>(),
})

// 2. The nodes: each returns a PARTIAL state update
async function proposeScope(state: typeof State.State) {
  // interrupt() pauses the graph here and surfaces this value to the caller
  const answer = interrupt({ question: '5 questions on the whole document. Go ahead?' })
  return { confirmed: answer === 'yes' }
}

async function createQuiz(state: typeof State.State) {
  const result = await generateQuiz({ documentId: state.documentId }, Date.now())
  return { quiz: result.ok ? result.quiz : null }
}

// 3. The graph
const graph = new StateGraph(State)
  .addNode('proposeScope', proposeScope)
  .addNode('createQuiz', createQuiz)
  .addEdge(START, 'proposeScope')
  .addConditionalEdges('proposeScope', (s) => (s.confirmed ? 'createQuiz' : END))
  .addEdge('createQuiz', END)
  .compile({ checkpointer: new MemorySaver() })

// 4. Run: first message
const config = { configurable: { thread_id: sessionId } }
await graph.invoke({ documentId }, config)          // stops at the interrupt

// 5. Run: next message, resume with the user's answer
await graph.invoke(new Command({ resume: 'yes' }), config)
```

The ideas to hold on to:

* **Checkpointer** = where state is saved after every step. `MemorySaver` is in-memory (dev only, same problem as a `Map`). For real use there's a Postgres checkpointer (`@langchain/langgraph-checkpoint-postgres`) which creates its own tables: your `workflow_runs`, written by someone else.
* **`thread_id`** = which saved run to load. Your `sessionId`.
* **`interrupt()`** = suspend. **`Command({ resume })`** = resume with a value.
* **Reducers**: each state field can define how updates merge (replace vs append). Appending is how message lists grow.

One real gotcha: when a graph resumes, **the interrupted node runs again from its first line**, and `interrupt()` returns the resume value this time. So anything in that node *before* the `interrupt()` call executes twice. Keep side effects after the interrupt, or in a separate node.

LangGraph is not the same as LangChain's high-level "chains". You can use it with plain functions and your own `fetch`-based Gemini calls; it doesn't require LangChain's model wrappers.

---

# 17. Other Tools in This Space

So the names aren't strangers:

| Tool | What it is |
|---|---|
| **LangGraph** | graph-based agent/workflow library with checkpointing and interrupts |
| **Mastra** | TypeScript AI framework (agents, tools, memory, RAG, evals, **workflows**). DocMind's Phase 8 uses only its workflow engine + Postgres storage (Part 2) |
| **Temporal** | heavy-duty durable execution engine; workflows as code, replayed from an event history |
| **Inngest** | event-driven durable functions (`step.run`, `step.waitForEvent`) |
| **AWS Step Functions** | state machines defined as JSON, managed by AWS |
| **XState** | state machine library, common in frontends |
| **BullMQ Flows** | parent/child job trees (durable, but no "wait for a human") |

They all solve the same three problems: **persist state between steps, resume after a crash or a wait, retry a failed step without redoing the finished ones.**

---

# 18. Workflow vs Agent vs Queue

Easy to blur:

```text
QUEUE      "do this slow thing later, with retries"          one step, no human
WORKFLOW   "do these steps in order, pausing when needed"    many steps, state between them
AGENT      "let the model choose the next step"              the path isn't fixed
```

They combine. A workflow step can enqueue a job and suspend until it finishes. An agent can be one node inside a workflow. A human-approval step can sit inside an agent loop.

---

# 19. When NOT to Build a Workflow

* The task finishes in one request. (Today's `/quiz` with a button is already a great UX.)
* The "state" is one boolean. A column on an existing table may be enough.
* A UI form would collect the same inputs with zero ambiguity.

Honest note: for DocMind, a **button + modal** is already a good product, and since AG.5 (2026-11-02) the button exists (the click carries the `documentId`, so no state is needed). Phase 8 adds what a button can't do: a **typed** answer ("yes", "the second one", "cancel") that has to be matched to an offer made in an earlier request. It's built to learn the mechanics of suspend/resume, which matter enormously in real agent systems (approvals, long-running tasks). Say that if asked; it shows judgment.

---

# 20. Where the Code Will Go (the Mastra plan)

Originally this section planned `workflows/hand-rolled/` and `workflows/langgraph/` side by side. The plan is now Mastra ([suspend-resume.md](../../suspend-resume.md) §7 has the full file list):

```text
src/
  mastra/index.ts                              the Mastra instance: storage (WorkflowsPG on the existing pool, schema 'mastra'),
                                               workflows: { quizWorkflow }, logger off, recovery off
  mastra/workflows/quiz.workflow.ts            4 steps: resolve-document → choose-document → confirm → generate-quiz
  services/quizWorkflow.service.ts             startQuizRun / resumeQuizRun / cancelQuizRun: the ONLY Mastra caller outside src/mastra/
  services/quizReply.service.ts                interpretQuizReply(): "yes" / "2" / "the React one" / "cancel" → an action (rules, then LLM)
  repositories/quizWorkflowRuns.repository.ts  the pointer table: which run is waiting in which user's chat
  db/schema.ts                                 + quiz_workflow_runs (+ SQL in a comment, run on Neon by hand)
  services/chat.service.ts                     prepareChat: check for a waiting run BEFORE embedding
  routes/chat.routes.ts                        run the start/resume/cancel at step 7, send `status` + `quiz` events
  routes/quizRuns.routes.ts                    POST /quiz-runs/:runId/resume (what the buttons call)
  step8-mastra-poc.ts                          WF.1 proof of concept (npm run step8)
```

The "built it by hand to understand it, then used a framework" story still works: Part 1 is the by-hand understanding, and the WF.1 proof of concept makes you read the raw snapshot row Mastra writes (`inspect` mode), which is exactly the `state jsonb` you'd have written yourself.

Log every transition with `pipelineLogger` (a new `workflow` theme: `run started`, `suspended at confirm`, `resumed`, `success`). A workflow you can't see in the terminal is very hard to debug.

---

# 21. Testing Workflows

State machines are the most testable thing in an AI backend, because the transitions are **pure logic**:

```text
given step=awaitConfirmation, input="yes"  → nextStep=done, status=COMPLETED, generateQuiz called once
given step=awaitConfirmation, input="no"   → status=COMPLETED, generateQuiz NOT called
given step=awaitConfirmation, input="what about chapter 3?" → cancelled, falls through to chat
generateQuiz returns { ok: false }         → status=FAILED
two concurrent resumes                     → only one claims the run
state loaded from DB with a missing field  → rejected by Zod, not a crash
expired run                                → ignored
```

Mock `classifyConfirmation` and `generateQuiz`. No LLM needed. This is Step 9.1's third test target.

---

# 22. Interview-Level Summary

If asked **"What is a suspend/resume workflow?"**:

> A multi-step process that spans several requests. When it needs outside input, it saves its current step and collected data to the database and stops: that's suspend. When the next message arrives, the server loads that state and continues from the saved step: that's resume. Nothing actually waits in memory.

If asked **"Why not keep the state in memory?"**:

> It wouldn't survive a restart or a deploy, and it wouldn't work with more than one server instance. The state has to live in shared storage, keyed by something the client sends back, like a session id.

If asked **"How would you build it by hand?"**:

> As a state machine: a `workflow_runs` table with the current step, a JSON state column, and a status. Each step is a function from state plus input to next step, new state and status. On every message I first check for a suspended run for that session; if there is one I resume it, otherwise I route normally. I save after every step and before replying.

If asked **"How does DocMind do it?"** (once Phase 8 is built; Mastra-specific answers are in §45):

> With Mastra's workflow engine, used as a library inside Express. The quiz flow is four Mastra steps that call my existing services; a step that needs the user calls `suspend()`, and Mastra saves a snapshot in Postgres. My own small table maps user + chat session to the run id, so finding the run and checking ownership stays in my code. The next message is read by a rules-first reply reader, and I call `resume()` with the parsed answer.

If asked **"What goes wrong?"**:

> Double-submits resuming the same run twice, which I prevent with an atomic status update. Non-serializable state. The world changing while suspended, so I re-validate on resume. The user changing the subject instead of answering. And abandoned runs, which need an expiry.

If asked **"Why use LangGraph if you can hand-roll it?"**:

> For anything bigger it gives me checkpointing, interrupts, retries, branching and tooling without maintaining my own engine. I built the small version first so I'd know what the framework is doing: nodes are my steps, the checkpointer is my table, the thread id is my session id.

If asked **"What's durable execution?"**:

> State is persisted after each step, so a crash or a failed step resumes from the last completed step instead of starting over. It depends on steps being idempotent.

---

# 23. Things That Will Bite You

* State in a `Map` → gone on restart.
* Replying before saving.
* Putting a `Date` or a class instance into state.
* No expiry → yesterday's suspended run eats today's first message.
* Two outputs (`yes`/`no`) where three are needed.
* Two requests resuming the same run.
* LangGraph: code before `interrupt()` runs again on resume. (Mastra: the same, code before the `suspend()` check runs again. §32)
* `MemorySaver` in anything deployed.
* A new SSE event the frontend doesn't know about.
* Mastra-specific ones (boot recovery, `bail()` = success, `cancel()` not stopping a running step, telemetry, tables created at startup): §44.

---

# 24. Final Mental Model

```text
                     MESSAGE ARRIVES (sessionId)
                               │
                               ▼
                 open run for this session?
                    │                  │
                   no                 yes
                    │                  │
                    ▼                  ▼
             route normally      claim it atomically
                    │            (SUSPENDED → ACTIVE)
          starts a workflow?           │
                    │                  ▼
                    ▼            load step + state
              create run               │
                    │                  ▼
                    └──────►  RUN THE STEP FUNCTION
                              (state, input) → (nextStep, state, status)
                                       │
                                       ▼
                              SAVE to workflow_runs
                                       │
                         ┌─────────────┼──────────────┐
                         ▼             ▼              ▼
                     SUSPENDED     COMPLETED        FAILED
                     ask the       reply with       clean error,
                     user, stop    the result       state kept
```

**A workflow = steps + state + status, stored in a table.**

**Suspend = save and stop. Resume = load and continue. Nothing waits in memory.**

**Save before you reply. State must be plain JSON.**

**Claim a run atomically so it can't be resumed twice.**

**Understand it by hand first, then use a framework: steps = steps, storage = your table, run id = your row's id.**

---
---

# Part 2 — Mastra: the Engine DocMind Will Use

> **Status: planned, not built.** The plan is [suspend-resume.md](../../suspend-resume.md). The code below is a **sketch**: names and shapes were checked against Mastra 1.82.0's type definitions and the docs bundled in the package, but the real code gets written one step at a time (WF.0 → WF.5), and the proof of concept (WF.1) confirms the behaviour by actually running it. Where something is still unverified, it says so.

---

# 25. What Mastra Is

**Mastra** is an open-source TypeScript framework for building AI applications ([mastra.ai](https://mastra.ai), Apache-2.0). Think of it as a "batteries included" toolkit for AI backends written in TypeScript:

```text
@mastra/core  ─┬─ Agents          an LLM + tools + memory, running in a loop
               ├─ Tools           typed functions an agent can call (createTool)
               ├─ Workflows       steps in a fixed order, with suspend/resume     ◄── the ONLY piece DocMind uses
               ├─ Memory          conversation history, working memory
               ├─ RAG helpers     chunking, embedding, vector stores
               ├─ Evals/scorers   grading model outputs
               ├─ Storage API     where all of the above saves its data          ◄── only its "workflows" part
               └─ Server/Studio   an HTTP server + a local UI to run and inspect things
@mastra/pg    ─── Postgres adapters for that storage API (+ a pgvector store)    ◄── only WorkflowsPG
```

It's **modular**: you can import the workflow engine alone and give it only the workflow part of storage. Nothing forces you to run its server, use its agents, or call models through its wrappers.

**Analogy:** Mastra is a big toolbox. Phase 8 takes out **one tool** (the workflow engine) and leaves the rest of the box closed. Express is still the workshop, and DocMind's own code still does the real work.

**Where a framework like this pays off:** anything that has to *wait*: approvals, a user's choice, a webhook, a timer, a long job. Mastra gives you the boring-but-hard parts of waiting: saving state in a known format, continuing from a fresh process, refusing a double continue, and recording what happened at every step.

---

# 26. Why Mastra (and Not the Alternatives)

| Option | Good | Not so good, for DocMind |
|---|---|---|
| Hand-rolled table (§8) | Zero dependencies, you see every line | You design and test the snapshot format, the claim, step ordering and recovery yourself. (This was the original roadmap plan.) |
| LangGraph.js (§16) | The most-cited name; graph model with checkpointers | Brings in LangChain packages; graph + reducer idioms; not the framework Shiv picked |
| **Mastra workflows** | TypeScript-first; **Zod schemas everywhere** (DocMind's style already); Postgres storage that can **reuse your existing pool**; the **atomic resume claim** is built in; a step is "an async function that calls my service" | A big dependency (~89 MB unpacked); releases very often (core was at 1.82 on 2026-11-07); telemetry **on** by default; boot recovery **on** by default; creates its own tables |
| Temporal / Inngest | Industrial-strength durable execution | A separate service or cloud account to run; far more than one quiz flow on a free tier needs |

**Why Mastra was chosen:** Shiv wants hands-on experience with a real TypeScript AI framework, Mastra's workflow model fits DocMind's existing style (Zod, plain async functions), and its Postgres storage means **no new service** (Neon is already there).

**The honest trade-off, worth saying out loud in an interview:** for one two-step flow, a hand-rolled table would be ~150 lines and no dependency. Mastra is chosen to learn a real engine and to get its guarantees (snapshots, the claim, recovery controls) without maintaining them, not because this problem was too big to build by hand. Part 1 is the proof that you understand what it does underneath.

---

# 27. Where Mastra Sits in DocMind

```text
┌─────────────────────────────────── DocMind (unchanged) ─────────────────────────────────────┐
│ browser ─► Express ─► cors ─► requireAuth ─► chat route ─► prepareChat ─► router/agent/... │
│                                                  │              │                           │
│                                                  │              └─ NEW, before embedding:   │
│                                                  │                 waiting quiz run for     │
│                                                  │                 (this user, this chat)?  │
│                                                  │                 → pointer table (SQL)    │
│                                                  │                 → reply reader           │
│                                                  ▼                                          │
│                                    quizWorkflow.service.ts  ◄── the boundary               │
└──────────────────────────────────────────────┬──────────────────────────────────────────────┘
                                               │ start / resume / cancel  (runId, input, resumeData)
┌──────────────────────────── Mastra (new: src/mastra/) ──────────────────────────────────────┐
│   Mastra instance ── quiz workflow (4 steps) ── WorkflowsPG storage                          │
└──────────────┬─────────────────────────────────────────────────────────┬────────────────────┘
               │ steps call back into DocMind                            │ snapshots
               ▼                                                         ▼
  listDocuments · checkDocumentReady · generateQuiz()          Neon Postgres, schema "mastra"
  (existing services + repositories, unchanged)                (mastra_workflow_snapshot, ...)
```

**What crosses the boundary:**

- **In:** the workflow input `{ userId, scope, documentId? }` and `resumeData` like `{ action: 'confirm' }` or `{ action: 'choose', documentId }`.
- **Out:** a run status (`suspended` / `success` / ...) plus either the suspend payload (the question) or the result (the quiz, or "cancelled").

**What never crosses:** the JWT, `req`/`res`, the raw chat message, the SSE stream, the session id.

**Same pattern as "only repositories touch SQL":** only `src/mastra/**` and `quizWorkflow.service.ts` import Mastra. Everything else gets DocMind-shaped `{ ok, ... }` results. If Mastra were ever swapped out, only those files would change.

---

# 28. The Packages, and the CommonJS Question

| | `@mastra/core` 1.82.0 | `@mastra/pg` 1.35.0 |
|---|---|---|
| What | the engine (and everything else in §25) | Postgres storage adapters |
| Needs | Node **≥ 22.13.0**; peer `zod ^3.25 \|\| ^4` | peer `@mastra/core >=1.80 <2`; `pg ^8.23` |
| DocMind has | Node 22.14 locally (`engines: "22.x"`); Zod 4 ✓ | `pg ^8.23.0` ✓ |
| Size | ~89 MB unpacked; pulls in `hono`, `posthog-node` and AI SDK packages even though DocMind won't use them | small |

**The CommonJS question (why WF.0 exists).** JavaScript has two module systems:

```text
CommonJS (CJS):   const x = require('pkg')     ← DocMind compiles to this ("type": "commonjs", module: commonjs)
ES modules (ESM): import x from 'pkg'          ← most new packages are written in this
```

A package that ships **only** ESM can be awkward or impossible to load from a CommonJS project. Mastra's `package.json` says `"type": "module"`, which looks bad at first, but its `exports` map has a **`require` entry** for each entry point, pointing at `.cjs` files (simplified):

```json
"exports": {
  "./workflows": {
    "import":  "./dist/workflows/index.js",
    "require": "./dist/workflows/index.cjs"
  }
}
```

That makes it a **dual package**: `require('@mastra/core/workflows')` gets the CommonJS build. WF.0 still checks three things for real: TypeScript finds the types under DocMind's older `node10` module resolution (Mastra ships root-level stub `.d.ts` files for exactly that), `ts-node-dev` runs it, and `npm run build && npm start` runs it.

**Memory on Render:** the free plan has 512 MB. WF.0 measures `process.memoryUsage().rss` before and after loading Mastra, so this isn't a guess.

---

# 29. Building Block 1: a Step

A **step** is one unit of work: an id, four Zod schemas, and an `execute` function.

```ts
import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'

// Sketch of the planned "confirm" step
const confirmStep = createStep({
  id: 'confirm',
  inputSchema:   z.object({ userId: z.string(), documentId: z.string(), filename: z.string(), picked: z.boolean() }),
  suspendSchema: z.object({ documentId: z.string(), filename: z.string() }),     // what the user is being asked about
  resumeSchema:  z.object({ action: z.enum(['confirm', 'cancel']) }),             // what counts as an answer
  outputSchema:  z.object({ userId: z.string(), documentId: z.string(), filename: z.string() }),

  execute: async ({ inputData, resumeData, suspend, bail }) => {
    const { userId, documentId, filename, picked } = inputData

    if (picked) return { userId, documentId, filename }                // they just chose it: choosing = yes
    if (!resumeData) return await suspend({ documentId, filename })    // first visit: ask, save, stop
    if (resumeData.action === 'cancel') return bail({ outcome: 'cancelled' })
    return { userId, documentId, filename }                            // confirmed: on to generate-quiz
  },
})
```

**The four schemas:**

| Schema | Describes | When it's checked |
|---|---|---|
| `inputSchema` | what the step receives: the previous step's output, or the workflow input for the first step | before `execute` runs |
| `outputSchema` | what it hands to the next step | when it returns |
| `suspendSchema` | the payload saved when it pauses: **what the user was shown** | when `suspend()` is called |
| `resumeSchema` | what `resume()` must pass in: **the parsed answer** | when `resume()` is called, before the step runs |

Mastra validates start and resume input by default (`validateInputs`): bad `resumeData` throws instead of resuming. It's the same idea as validating a request body with Zod at the route.

**The `execute` arguments DocMind will use:**

| Argument | What it is |
|---|---|
| `inputData` | this step's input (validated) |
| `resumeData` | `undefined` on the first visit; the answer on a resumed visit |
| `suspendData` | on a resumed visit, the payload this step passed to `suspend()` (e.g. the candidate list it showed) |
| `suspend(payload)` | pause here: saves the snapshot and ends the current `start()`/`resume()` call |
| `bail(result)` | end the whole workflow now, with `result` as its output |
| `runId`, `resourceId` | which run this is |
| `abortSignal` | fires on `run.cancel()`; a step only stops early if it listens |

(There's also `state` / `setState` for a workflow-wide shared state, `retryCount`, `getStepResult`, `requestContext` and more. DocMind doesn't need them.)

**Key mental shift:** a step doesn't *remember* anything. It's a function of `(inputData, resumeData)`. Mastra stores both and feeds them back in. That's exactly why it survives a restart.

---

# 30. Building Blocks 2 and 3: the Workflow and the `Mastra` Instance

**The workflow** chains steps. Each step's output becomes the next one's input (they must line up), and `.commit()` finalizes it:

```ts
import { createWorkflow } from '@mastra/core/workflows'

export const quizWorkflow = createWorkflow({
  id: 'quiz-workflow',
  inputSchema:  z.object({ userId: z.string(), scope: z.enum(['one', 'all']), documentId: z.string().optional() }),
  outputSchema: QuizRunOutput,   // one union for every ending: quiz | cancelled | nothing_ready | error
})
  .then(resolveDocumentStep)     // never suspends
  .then(chooseDocumentStep)      // suspends when there are several candidates
  .then(confirmStep)             // suspends unless the user just picked
  .then(generateQuizStep)        // calls generateQuiz()
  .commit()
```

Mastra has more control flow (`.parallel()`, `.branch()`, `.dountil()`, `.foreach()`, nested workflows, `.sleep()`). The quiz doesn't need any of it: "skip this step" is a plain `if` inside `execute` that returns its input unchanged.

**The `Mastra` instance** is the registry. A workflow on its own has nowhere to save snapshots. Registering it with a `Mastra` that has storage is what makes it durable:

```ts
// src/mastra/index.ts (sketch)
import { Mastra } from '@mastra/core'
import { MastraCompositeStore } from '@mastra/core/storage'
import { WorkflowsPG } from '@mastra/pg'
import { pool } from '../db/client'               // WF.0 exports the pool db/client.ts already creates

export const mastra = new Mastra({
  storage: new MastraCompositeStore({
    id: 'docmind',
    domains: { workflows: new WorkflowsPG({ pool, schemaName: 'mastra' }) },   // ONLY the workflows domain
  }),
  workflows: { quizWorkflow },
  logger: false,                                  // D7: pipelineLogger stays the log (confirmed in WF.0)
  recovery: { workflows: 'off' },                 // D5: no boot-time restarts (§35)
})

// anywhere else (only quizWorkflow.service.ts, by the boundary rule):
const workflow = mastra.getWorkflow('quizWorkflow')
```

Compare: `db/client.ts` creates one Drizzle `db` that every repository imports. `src/mastra/index.ts` creates one `mastra` that the workflow service imports. Same shape.

---

# 31. A Run's Life, Traced Across Three Requests

The single most important section. Follow one quiz from offer to modal.

### Request 1: "quiz me" (one-document chat)

```ts
// quizWorkflow.service.ts (sketch)
const runId = randomUUID()
const run = await mastra.getWorkflow('quizWorkflow').createRun({ runId })
const result = await run.start({ inputData: { userId, scope: 'one', documentId } })

// result.status                              → 'suspended'
// result.suspended                           → [['confirm']]            (the path to the paused step)
// result.steps.confirm.suspendPayload        → { documentId, filename }

await createWaitingRun({ runId, userId, sessionId, waitingFor: 'confirm' })   // DocMind's pointer row
// reply: "Want a 5-question quiz on **x.pdf**?"
```

What happened **inside** `start()`:

```text
resolve-document  → 1 ready document → output { documentId, filename, candidates: [it] }
choose-document   → only 1 candidate → passes it on (no suspend)
confirm           → no resumeData → suspend({ documentId, filename })
                    → Mastra writes the snapshot (status 'suspended') to mastra.mastra_workflow_snapshot
                    → start() resolves with status 'suspended'
```

After `start()` returns, **nothing is running and nothing is waiting in memory.** There's no pending promise and no timer. The request ends. The process can be killed.

### (Minutes pass. Render deploys, or sleeps and wakes. A different process now.)

### Request 2: "yes"

```ts
const pending = await findWaitingRun(sessionId, userId)                // DocMind SQL, user + session scoped
const answer  = await interpretQuizReply('yes', pending.waitingFor)    // → { action: 'confirm' }   (rules, no LLM)

const run = await mastra.getWorkflow('quizWorkflow').createRun({ runId: pending.runId })   // a HANDLE to the old run
const result = await run.resume({ step: 'confirm', resumeData: answer })

// result.status   → 'success'
// result.result   → { outcome: 'quiz', documentId, filename, quiz }
```

`createRun({ runId })` with an id that already exists doesn't make a new run. It gives you a handle to that run, which is what the docs say to do when "resuming with only a runId".

What happened **inside** `resume()`:

```text
1. CLAIM      one atomic update: status 'suspended' → 'running'   (fails if someone else got there first, §33)
2. LOAD       read the snapshot for this runId
3. RE-RUN     confirm's execute runs again FROM ITS FIRST LINE, now with resumeData = { action: 'confirm' }
              → returns { userId, documentId, filename }
4. CONTINUE   generate-quiz → generateQuiz({ documentId, userId })   (re-checks ownership + ready, retries once)
5. SAVE       snapshot updated: every step's status/output, run status 'success', result = the quiz
6. RETURN     resume() resolves with status 'success'
```

### Request 2, continued: back in DocMind

```text
pointer → 'done'
SSE `status` "Writing your quiz…" (sent just before resume, so the user isn't staring at dots for 5–15 s)
SSE `quiz` event with the quiz  →  the frontend opens QuizModal
"Here's your quiz on x.pdf." saved to chat_messages as the assistant reply
```

### On one timeline

```text
time ────────────────────────────────────────────────────────────────────────────────────────────►
REQ 1  [start → resolve → choose → confirm: suspend → SAVE] reply      (the process may die here)
                                                          │
                                    snapshot row: status 'suspended', paused at 'confirm'
                                                          │
REQ 2                                                     [claim → load → confirm again → generate → SAVE] quiz
```

---

# 32. The Paused Step Runs Again From Its First Line

On resume, Mastra doesn't jump into the *middle* of `execute`. It calls `execute` **again from the top**, this time with `resumeData` set. That's why every example in the docs is shaped like this:

```ts
execute: async ({ inputData, resumeData, suspend }) => {
  // ← everything up here runs TWICE: on the first visit AND on the resume
  if (!resumeData) return await suspend({ ... })
  // ← everything down here runs once, after the answer arrives
}
```

The bug it causes:

```ts
execute: async ({ resumeData, suspend }) => {
  await insertMessage(...)                    // ✗ runs on start AND on resume → saved twice
  const quiz = await generateQuiz(...)        // ✗ a Gemini call spent before the user even said yes
  if (!resumeData) return await suspend(...)
}
```

**Rule:** above the `suspend` check, only cheap reads. Side effects go below it, or into the **next** step. That's exactly why the plan has `generate-quiz` as its own step after `confirm`, instead of generating inside `confirm`.

LangGraph has the same rule for `interrupt()` (§16). It's the same "this code may run twice" thinking as idempotent BullMQ jobs (topic 09). The WF.1 proof of concept will count `execute` calls to *show* it rather than trust it.

---

# 33. The Resume Claim: Two Resumes, One Quiz

The race from §10, Mastra edition. A user clicks **Create quiz** and types "yes" at the same moment:

```text
request A (click):   resume(run 42) ──► UPDATE … status='running' WHERE run=42 AND status='suspended'  → 1 row ✓ continues
request B ("yes"):   resume(run 42) ──► the same UPDATE                                                → 0 rows ✗
                                         throws MastraError { id: 'WORKFLOW_RESUME_ALREADY_CLAIMED' }
                                         (no step runs, so no second quiz)
```

From Mastra's own reference: *"Only one `resume()` call can continue a suspension. Before it runs anything, `resume()` atomically claims the run by moving its stored status from `suspended` to `running`."* Mastra's own HTTP server answers the loser with **409 Conflict**, and DocMind will do the same.

Two conditions, both met by DocMind's plan:

- **The storage must support atomic updates.** `WorkflowsPG.supportsConcurrentUpdates()` returns `true` (Postgres). Adapters like Redis or Cloudflare KV can't enforce the claim.
- **The snapshot must be saved in the `running` state** (`shouldPersistSnapshot` must not exclude it). DocMind doesn't set that option, so the default applies.

```ts
// quizWorkflow.service.ts (sketch)
try {
  result = await run.resume({ step, resumeData })
} catch (err) {
  if ((err as { id?: string }).id === 'WORKFLOW_RESUME_ALREADY_CLAIMED') {
    return { ok: false, status: 409, error: 'That quiz is already being made.' }   // a normal outcome, not a crash
  }
  throw err                                                                          // anything else → withErrorHandling
}
```

**Why DocMind's pointer row isn't the lock.** Both requests could read the pointer as `waiting` at the same instant: a check-then-act on the pointer has the race. Mastra's conditional update is the real lock, and the pointer is just the index card. (Same lesson as auth's duplicate emails: the `UNIQUE` constraint decides, not a check-then-insert.)

---

# 34. Run Statuses, and the Ways a Run Ends

| Status | Meaning | DocMind sees it when |
|---|---|---|
| `pending` | created, not started | between `createRun` and `start` |
| `running` | a step is executing | during `start()` / `resume()`, or forever if the process died mid-step (§35) |
| `suspended` | paused in a step, waiting for `resume()` | the offer or the document list is waiting for an answer |
| `success` | finished, `result` is set | quiz made, **or** bailed (see below) |
| `failed` | a step threw (after its retries) | a Mastra or storage error |
| `canceled` | `run.cancel()` was called | the user said "cancel", changed the subject, or the run expired |
| `waiting` | paused by `.sleep()`, or the executor was interrupted | not used by the quiz |
| `tripwire`, `paused`, `skipped`, `bailed` | other features (`bailed` is reported for the *step*) | not used |

**The ways a run can end:**

1. **The last step returns** → `success`, `result` = its output.
2. **`bail(payload)`** → also **`success`**, `result` = the bail payload. Mastra's reference: *"The run itself completes with a success status and the bail payload as its result."* So `status === 'success'` does **not** mean "a quiz was made". That's why DocMind's output has an `outcome` field (`'quiz' | 'cancelled' | 'nothing_ready' | 'error'`), and the code checks `outcome`.
3. **A step throws** → `failed`. The plan avoids this for expected problems: `generateQuiz()`'s 404/409/502 become an `outcome: 'error'` *result*, so the run ends cleanly with a message (D6). Only real crashes become `failed`.
4. **`run.cancel()`** → `canceled`. It works on **suspended** runs, which is how DocMind drops a waiting offer. On a **running** step it fires `abortSignal`, and the step keeps going unless it listens. `generateQuiz()` doesn't listen, so cancelling mid-generation only stops the steps after it. Calling `cancel()` on a finished run leaves it unchanged.

What `resume()` does on a run that's already finished or cancelled gets recorded in WF.1 (`again` and `cancel` modes), so the service handles it from evidence, not a guess.

---

# 35. Crash Recovery on Boot, and Why DocMind Turns It Off

After a crash, a run can be unfinished in two ways:

```text
SUSPENDED  → nothing to recover. It's a row waiting for an answer. The next message resumes it.  ✓
RUNNING    → the process died INSIDE a step (for the quiz: inside generate-quiz, the only slow one).
```

For `running` runs, Mastra has **boot recovery**. From the `Mastra` class reference: `recovery.workflows: 'auto' | 'off'`, default **`'auto'`**: on server boot, restart the workflow runs found in storage as `running`/`waiting`, 5 at a time (`workflowConcurrency`). A single workflow can also opt out with `options: { autoRestartActiveRuns: false }`.

**Why that's wrong for DocMind's quiz:**

- The request that wanted the quiz died with the old process. Its SSE stream is gone, so nobody is listening for the result.
- Restarting `generate-quiz` spends 1–2 Gemini calls (Flash-Lite free tier: 15 per minute, 500 per day) on a quiz nobody will receive.

**So:** `recovery: { workflows: 'off' }` (D5), plus DocMind's own **stale rule**: a pointer stuck in `running` for more than 3 minutes counts as failed, and the next message says "That quiz didn't finish, ask again."

**Contrast with BullMQ (topic 09)**, where re-running a stalled job *is* right: nobody waits for the embedding job live, the result (a `ready` document) is still wanted later, and the job is idempotent. **Recovery is right when the result is still wanted after the crash.** For a live chat reply, it isn't.

---

# 36. Retries: Mastra's vs `generateQuiz()`'s

Mastra can retry a step that throws: `retries: n` on a step, or `retryConfig: { attempts, delay }` on the whole workflow.

`generateQuiz()` already retries once internally (2 attempts, then a clean 502), with Zod validation each time. Stacking both multiplies the calls:

```text
2 extra Mastra attempts  ×  2 generateQuiz attempts  =  up to 6 Gemini calls for one quiz
```

**Plan:** no Mastra retries on the quiz steps. Retry in one place: the place that knows what a "bad" reply looks like.

---

# 37. Storage: Where the Snapshots Live

```text
Neon Postgres (the one DocMind already uses)
├── public.*    users, documents, chunks, chat_messages, + quiz_workflow_runs (WF.2)   ← yours, hand SQL
└── mastra.*    mastra_workflow_snapshot, mastra_workflow_run_owners                  ← Mastra's, it creates them
```

- **Only the workflows domain.** `MastraCompositeStore({ domains: { workflows: ... } })` switches on workflow storage only. No memory, observability or eval tables.
- **One connection pool.** `WorkflowsPG({ pool })` accepts an existing `pg.Pool`, so Mastra shares DocMind's connections instead of opening more. `db/client.ts` creates the pool but doesn't export it; WF.0 adds one `export`. Mastra's bundled Neon notes also say to use the **pooled** connection string.
- **A separate schema.** `schemaName: 'mastra'` keeps its tables out of `public`. WF.0 checks whether Mastra also creates the schema or whether you run `CREATE SCHEMA mastra` once.
- **Mastra creates its own tables.** On startup it calls `storage.init()` and creates tables + indexes (`disableInit: true` turns that off). It's the one exception to "every table by hand SQL on Neon" (CLAUDE.md §5) and will be written down there.
- **The two tables.** `mastra_workflow_snapshot` holds one row per run (unique on `workflow_name + run_id`) with the snapshot JSON. `mastra_workflow_run_owners` holds **execution leases**: which *process* is currently driving a run. That's about processes, not users, and has nothing to do with DocMind's user ownership.
- **Size.** The snapshot holds every step's input and output. Keep payloads small: ids and filenames, never chunks or embeddings (rule 9 of the plan). The finished quiz (~2–4 KB of JSON) does land in the snapshot as the result, which is fine.
- **Retention.** Rows stay forever by default. D8 keeps them for now (useful to inspect while learning); tests delete their own.

### What a snapshot looks like (illustrative)

The shape comes from Mastra's snapshot docs. WF.1's `inspect` mode will print the real one.

```json
{
  "runId": "5b1e…",
  "status": "suspended",
  "context": {
    "input": { "userId": "u_123", "scope": "one", "documentId": "d_9" },
    "resolve-document": { "status": "success", "output": { "documentId": "d_9", "filename": "x.pdf", "candidates": ["…"] } },
    "choose-document":  { "status": "success", "output": { "documentId": "d_9", "filename": "x.pdf", "picked": false } },
    "confirm": {
      "status": "suspended",
      "payload": { "documentId": "d_9", "filename": "x.pdf", "picked": false },
      "suspendPayload": { "documentId": "d_9", "filename": "x.pdf" },
      "suspendedAt": 1762500000000
    }
  },
  "suspendedPaths": { "confirm": [2] },
  "serializedStepGraph": ["… the 4 steps …"],
  "timestamp": 1762500000001
}
```

Read it as Part 1's `workflow_runs` row: `status` = the status column, the `confirm` entry = `current_step`, `context` = the `state jsonb`. Same idea, richer format.

---

# 38. Finding the Run: `runId`, `resourceId`, and DocMind's Pointer Table

Mastra finds a run by **`runId`**. The chat only knows **`userId` + `sessionId`**. Something has to connect them.

| | Option A: Mastra's `resourceId` | **Option B: a DocMind pointer table (recommended, D2)** |
|---|---|---|
| How | `createRun({ runId, resourceId: "<userId>:<sessionId>" })`, then `listWorkflowRuns({ resourceId, status: 'suspended' })` | `quiz_workflow_runs(run_id, user_id, session_id, status, waiting_for, expires_at)` |
| New table | no | yes, small, hand SQL |
| Ownership check | inside a string you build and parse | `WHERE user_id = $1 AND session_id = $2`, like every other repository |
| "One waiting quiz per chat" | your code has to enforce it | a partial unique index enforces it |
| Expiry | read Mastra's timestamps | an `expires_at` column |
| Query it in the Neon editor | parse Mastra's JSON | plain columns |

**Analogy:** Mastra's snapshot table is the clerk's filing cabinet (the full file). The pointer table is **your receipt book**: "token 42 is mine, for this chat, valid until 3:30". You check your own book first, and only go to the cabinet with a token you know is yours.

**The pointer is never the truth about the steps.** Mastra's snapshot is. The pointer only says *whose* run it is, *which* chat, and *whether it's still wanted*.

---

# 39. What Mastra Does NOT Know (the Boundary)

| Question | Answered by |
|---|---|
| Who is asking? | DocMind (`requireAuth`, `req.user.id`) |
| Is this run theirs? | DocMind (pointer row `user_id`) |
| Is the document theirs, and ready? | DocMind (`checkDocumentReady`, called inside a step) |
| What did "the second one" mean? | DocMind (the reply reader) |
| Has the offer expired, or did the subject change? | DocMind |
| Which step comes next, what was saved, can this run be resumed? | **Mastra** |
| Did someone else already resume it? | **Mastra** (the claim) |

**Mastra has no idea about users.** Anyone with code access and a `runId` can resume a run. So the planned `POST /quiz-runs/:runId/resume` route treats `runId` as **untrusted input from the URL**:

```text
runId from URL → SELECT … FROM quiz_workflow_runs WHERE run_id = $1 AND user_id = <req.user.id>
                 → no row  → 404 (someone else's run looks like a missing one; Mastra is never called)
                 → row     → resume through quizWorkflow.service.ts
```

That's the same rule as `searchDocuments` having no `documentId` parameter (topic 10): **identity and scope come from code, never from something the client or the model can write.**

---

# 40. The Quiz Workflow, Step by Step (planned)

| Step | Suspends? | Suspend payload (what the user sees) | Resume data (the answer) | Calls |
|---|---|---|---|---|
| `resolve-document` | never | — | — | `listDocuments(userId)` (logic shared with today's `buildQuizOffer`) |
| `choose-document` | when there are **several** ready candidates | `{ candidates: [{ documentId, filename }] }` in the order shown | `{ action: 'choose', documentId }` or `{ action: 'cancel' }` | — |
| `confirm` | unless the user **just picked** one | `{ documentId, filename }` | `{ action: 'confirm' }` or `{ action: 'cancel' }` | — |
| `generate-quiz` | never | — | — | `generateQuiz({ documentId, userId })` |

```text
quiz-workflow  (input: { userId, scope: 'one' | 'all', documentId? })

  resolve-document ──(0 ready)──────────────────────────► bail { outcome: 'nothing_ready' }
        │ (1 candidate)                    │ (several)
        │                                  ▼
        │                           choose-document ──suspend { candidates }──► ⏸ "Which one? 1. … 2. …"
        │                                  │ resume choose                  │ resume cancel → bail 'cancelled'
        ▼                                  ▼
     confirm ──suspend { documentId, filename }──► ⏸ "Want a quiz on x.pdf?"   (skipped if just picked)
        │ resume confirm                  │ resume cancel → bail 'cancelled'
        ▼
  generate-quiz ── generateQuiz() ──► { outcome: 'quiz', quiz }  |  { outcome: 'error', message }
```

Three design choices worth noticing:

- **"The second one" means the second one the user *saw*.** The candidate list is saved in the suspend payload, so a document uploaded or deleted in the meantime doesn't shift the numbering. (`suspendData` hands the step that same list back on resume.)
- **Picking = yes.** Asking "are you sure?" right after someone picked a document is annoying, so `confirm` passes straight through when `picked` is true.
- **Re-check the world on resume.** `generateQuiz()` already runs `checkDocumentReady` (404 if deleted, 409 if not ready), so a document deleted while the offer waited gives a clean "that document isn't available any more".

---

# 41. Reading a Human's Reply

The workflow only accepts structured `resumeData`. People type sentences. Something in between turns one into the other: `interpretQuizReply()`, which is DocMind code, not Mastra.

```text
"yes" / "sure" / "go ahead"     → rules → { action: 'confirm' }               (only while waiting at confirm)
"no" / "cancel" / "nah"         → rules → { action: 'cancel' }
"2" / "second one" / "the last" → rules → { action: 'choose', documentId }    (out of range → unclear)
"the React document"            → rules (filename words) → one match: choose · several: unclear
"what's in chapter 3?"          → LLM label (JSON + Zod, temp 0) → usually 'unrelated'
```

- **Rules first**, because "yes" should never cost a Gemini call. It's the same hybrid as the intent router: the cheap check decides when it can, and the LLM only handles close calls.
- **The LLM only labels.** If it says `choose` with a `documentId`, code checks the id is one of the saved candidates; otherwise the reply counts as `unclear`.
- **`unclear`** → ask again; the run stays suspended (no Mastra call).
- **`unrelated`** → cancel the run and answer the message normally (D4). A "yes" three messages later shouldn't revive an old offer.
- **Where it runs:** at the very top of `prepareChat`, **before the embedding**, so a typed answer costs 0 embedding calls and 0 router calls.

---

# 42. What Changes on the Wire (planned, additive only)

`/chat-stream` for "quiz me", then "yes" (shape from [suspend-resume.md](../../suspend-resume.md) §4.7):

```text
── request 1: "quiz me" ───────────────────────────────────────────────────────────────
event: meta     data: {"sessionId":"…","sources":[],…}
data:           {"text":"Want a 5-question quiz on **x.pdf**?"}
event: action   data: {"type":"quiz_confirm","runId":"…","documentId":"…","filename":"x.pdf"}
event: done     data: {}

── request 2: "yes" ───────────────────────────────────────────────────────────────────
event: meta     data: {"sessionId":"…","sources":[],…}
event: status   data: {"text":"Writing your quiz from x.pdf…"}
data:           {"text":"Here's your quiz on **x.pdf**."}
event: quiz     data: {"runId":"…","documentId":"…","filename":"x.pdf","quiz":["…5 questions…"]}
event: done     data: {}
```

- `status` is the existing AG.4 event, reused. `quiz` is **new**. The `action` buttons now carry the `runId`.
- A button click calls the new `POST /quiz-runs/:runId/resume`, which goes through **the same** `resumeQuizRun()` as a typed "yes": one path, one set of tests, and the claim covers both.
- An older frontend bundle has no `case` for `quiz`, and its `dispatch()` has no `default`, so it skips the event and shows the text. Nothing crashes.
- `POST /quiz` (the header's "Generate quiz" button) is unchanged. It isn't a conversation.

---

# 43. Telemetry and Logging

- **Telemetry:** `@mastra/core` sends anonymous usage events to PostHog (OS, Node version, a hashed hostname); this was read in its compiled source. It's disabled when `MASTRA_TELEMETRY_DISABLED` is `1`, `true` or `yes`. The plan sets it in `.env`, `.env.example` and on Render (plan rule 14). Any library that phones home by default deserves that check.
- **Logging:** Mastra has its own logger. DocMind's log is `pipelineLogger`, and two loggers interleaving is noise, so Mastra's goes off or to warn level (D7, decided in WF.0 after seeing its output). Every transition gets a line in a new `workflow` theme: `run started`, `suspended at confirm`, `resumed (confirm)`, `success: quiz`, `claim lost → 409`.

---

# 44. Things That Will Bite You (Mastra edition)

* **Thinking `suspend()` keeps something alive.** It doesn't. It writes a row and returns. Plan for the process dying a second later.
* **Side effects above the `suspend` check** run twice (§32).
* **`status === 'success'` after a `bail()`** looks like a finished quiz. Check `outcome` (§34).
* **Boot recovery is on by default** and will re-drive a run that spends Gemini quota for nobody (§35). Turn it off.
* **`cancel()` doesn't stop a running step** unless the step listens to `abortSignal` (§34).
* **Stacked retries** (Mastra × `generateQuiz`) multiply Gemini calls (§36).
* **Treating `WORKFLOW_RESUME_ALREADY_CLAIMED` as a crash.** It's the claim working. Map it to a 409 or a short sentence (§33).
* **Using the pointer row as the lock.** Check-then-act races. Mastra's claim is the lock (§33).
* **Trusting a `runId` from the URL.** Look it up with `user_id` first; someone else's is a 404 (§39).
* **Big suspend payloads.** Ids and filenames only (§37).
* **Telemetry on, tables created at startup, `node_modules` growing ~89 MB.** All expected, all to be written down (§28, §37, §43).
* **A surprise minor version** mid-build. Mastra releases often; pin exact versions (D1).
* **Testing against the live database.** Local `.env` is production Neon. The PoC uses its own workflow id, and every test deletes only the runs it created (`deleteWorkflowRunById`).

---

# 45. Interview-Level Summary (Mastra)

If asked **"What is Mastra?"**:

> An open-source TypeScript framework for AI applications: agents, tools, memory, RAG, evals and a workflow engine. In DocMind I use only the workflow engine and its Postgres storage, as a library inside my Express app. Agents, tools and model calls stay my own code.

If asked **"What does `suspend()` actually do?"**:

> It saves a snapshot of the run to Postgres (every step's input and output so far, plus the payload I pass, which is the question for the user), marks the run `suspended`, and returns. Nothing keeps running. The HTTP request ends normally.

If asked **"How does a resume work after a restart?"**:

> A new request finds the run id, I get a handle with `createRun({ runId })`, and call `resume()` with the user's parsed answer. Mastra claims the run, loads the snapshot, and runs the paused step again from the top, this time with the answer in `resumeData`. Then it continues through the remaining steps. Everything it needs is in the database, so it doesn't matter that it's a different process.

If asked **"What stops a double resume?"**:

> Mastra claims the run with one atomic update from `suspended` to `running`. Only one caller's update matches; the other gets `WORKFLOW_RESUME_ALREADY_CLAIMED` before any step runs. That needs storage with atomic updates, which Postgres has. I map it to a 409.

If asked **"What if the server crashes in the middle of a step?"**:

> The run is left `running`. Mastra can restart such runs on boot, but I turned that off: the request that wanted the quiz is gone, so regenerating it would spend LLM quota for nobody. A pointer stuck in `running` for a few minutes counts as failed, and the user is told to ask again.

If asked **"How do you keep users apart if Mastra doesn't know about users?"**:

> Mastra only knows run ids. My own table maps user plus chat session to the run id, and every lookup filters on both. A run id from a URL is looked up with the caller's user id first, and someone else's is a 404 before Mastra is ever called. The steps also re-check document ownership when they run.

If asked **"Where does the LLM fit?"**:

> In two places, both bounded. The existing quiz generation runs inside the last step. And when a typed reply doesn't match simple rules, a classifier labels it (confirm, cancel, choose, unclear, unrelated). The label is validated in code and code decides what happens. The model never moves the workflow by itself.

If asked **"Why a framework for something this small?"**:

> Honestly, for one flow, a table and a conditional update would do. I wanted to learn a real engine and get its guarantees (snapshots, the claim, recovery controls) without maintaining my own. And I know what it does underneath: step = function, snapshot = my state row, claim = conditional update, resume = load and continue.

If asked **"Workflow or agent?"**:

> A workflow: the path is fixed in code and only pauses for a person. DocMind's agent is a separate thing: for document questions the model chooses which tool to call. The quiz is a Kind B action, so the model never gets to start it, and a workflow with a human confirmation is the right shape for that.

---

# Part 2 in One Screen

```text
WHAT        Mastra = TypeScript AI framework. DocMind uses ONE piece: the workflow engine + Postgres storage.
WHERE       Express → prepareChat → quizWorkflow.service.ts (the boundary) → src/mastra → WorkflowsPG → Neon schema "mastra"
PIECES      step (createStep: input/output/suspend/resume schemas + execute)
            workflow (createWorkflow().then().commit())  ·  Mastra instance (storage + registry)
            run (createRun({ runId })) · start() · resume({ step, resumeData }) · cancel()
            snapshot = the run's whole state as one JSON row
SUSPEND     suspend(payload) → snapshot saved, status 'suspended', the call returns. Nothing stays in memory.
RESUME      claim (suspended → running, atomic) → load snapshot → the paused step runs AGAIN from the top
            with resumeData → later steps → snapshot saved → 'success'
SAFETY      two resumes → one wins, the other gets WORKFLOW_RESUME_ALREADY_CLAIMED (→ 409)
            boot recovery is 'auto' by default → DocMind sets 'off' + a 3-min stale rule
            bail() ends with 'success' → check `outcome`, not just the status
            cancel() stops later steps; a running step only stops if it listens to abortSignal
BOUNDARY    Mastra: order, pause, save, continue, claim.
            DocMind: who, whose run, which chat, what a reply means, expiry, SSE, the quiz itself.
REPLIES     rules first ("yes", "2", "the React one", "cancel") → LLM label only if unsure → code validates
WIRE        status (reused) · quiz (new) · action buttons with runId → POST /quiz-runs/:runId/resume (same path as typing)
```

**Mastra orchestrates, DocMind decides.**

**`suspend()` writes a row and returns. `resume()` claims, loads, and runs the paused step again.**

**The claim is the lock; the pointer table is the index card.**

**Turn off what spends money for nobody: boot recovery, stacked retries, telemetry.**
