import { z } from 'zod'

// LOCAL COPY of the `megabrain orchestrate graph --json` contract, owned by the CLI lane. Until that
// lane merges, this file stands in for its schema; at merge it is replaced by the real one. Unknown
// fields pass through (looseObject), so the CLI may add optional fields without breaking the view.

export const orchestrationStateSchema = z.enum(['starting', 'working', 'asking', 'idle', 'done', 'closed', 'failed', 'stalled'])

export const orchestrationMessageTypeSchema = z.enum(['received', 'ask', 'reply', 'done', 'change', 'supervise', 'stalled'])

export const orchestrationNodeSchema = z.looseObject({
  /** A dispatch id, or session:<agent>:<id> for a coordinator that is not a dispatch. */
  id: z.string(),
  kind: z.enum(['coordinator', 'lane']),
  parent: z.string().nullable(),
  label: z.string(),
  agent: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  state: orchestrationStateSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  contextPercent: z.number().nullable(),
  last: z.looseObject({ type: orchestrationMessageTypeSchema, text: z.string(), at: z.string() }).nullable(),
  finding: z.string().nullable(),
  /** The latest ask from this node has no reply from its parent yet. */
  unanswered: z.boolean(),
  worktree: z.string().nullable(),
  branch: z.string().nullable(),
  commits: z.number().nullable(),
  /** The app chat this node is, when it is one. */
  chatId: z.string().nullable(),
  /** agent:session id. */
  session: z.string().nullable(),
})

export const orchestrationEventSchema = z.looseObject({
  at: z.string(),
  node: z.string(),
  direction: z.enum(['to-parent', 'to-child']),
  type: z.string(),
  text: z.string(),
})

export const orchestrationGraphSchema = z.looseObject({
  version: z.literal(1),
  focus: z.string(),
  root: z.string(),
  nodes: z.array(orchestrationNodeSchema),
  /** Newest last, capped at 200. */
  events: z.array(orchestrationEventSchema),
})

export type OrchestrationState = z.infer<typeof orchestrationStateSchema>
export type OrchestrationNode = z.infer<typeof orchestrationNodeSchema>
export type OrchestrationEvent = z.infer<typeof orchestrationEventSchema>
export type OrchestrationGraph = z.infer<typeof orchestrationGraphSchema>

/** What the graph is asked about: an app chat, or any agent session (agent:id). */
export type OrchestrationTarget = { chat: string } | { session: string }
