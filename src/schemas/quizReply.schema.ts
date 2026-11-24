import { z } from 'zod'

// WF.4 — what the LLM must answer when it reads a reply to the quiz question
// (suspend-resume.md §4.5). Same two halves as the router (intent.schema.ts)
// and the quiz: Gemini is ASKED for this shape (the response schema below),
// and Zod VERIFIES it before anything trusts it.
//
// The four readings of a reply to "Want it?" / "Which document?":
//   choose     yes, or one document picked
//   cancel     no / not now / never mind
//   unclear    it IS an answer to the question, but not a clear one
//              ("the react one" with two React files, "both", "hmm")
//   unrelated  not an answer at all: a question about the content, a new
//              request, small talk. The quiz is dropped and the message is
//              answered normally (D4).
export const QUIZ_REPLY_ACTIONS = ['choose', 'cancel', 'unclear', 'unrelated'] as const

export const QuizReplyAction = z.enum(QUIZ_REPLY_ACTIONS)
export type QuizReplyAction = z.infer<typeof QuizReplyAction>

// { "action": "choose", "choice": 2 }
//
// `choice` is the document's NUMBER in the list the user was shown (1-based),
// not its id. A number is all the model has to copy, so it can't invent an id
// or mangle a uuid; code turns it into the document (and an out-of-range
// number becomes `unclear`, never a guess). Null for every other action.
export const QuizReplyLabel = z.object({
  action: QuizReplyAction,
  choice: z.number().int().nullable().optional(),
})
export type QuizReplyLabel = z.infer<typeof QuizReplyLabel>

// The same shape in Gemini's structured-output format (uppercase types, like
// intentResponseSchema). `enum` limits the model to exactly these 4 strings.
export const quizReplyResponseSchema = {
  type: 'OBJECT',
  properties: {
    action: { type: 'STRING', enum: [...QUIZ_REPLY_ACTIONS] },
    choice: { type: 'INTEGER', nullable: true },
  },
  required: ['action'],
}
