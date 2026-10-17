import { z } from 'zod'

// The knowledge base, per project (`knowledge list|search|show|transcript --json`): topics a curator
// builds from every chat's summaries, each with its sections, decisions, refs, key messages and the
// chats that built it, and each chat's distilled transcript.
export const knowledgeKindSchema = z.enum(['feat', 'fix', 'refactor', 'decision', 'investigation'])
export const knowledgeStatusSchema = z.enum(['active', 'shipped', 'dropped'])
export const knowledgeRefSchema = z.looseObject({
  kind: z.enum(['issue', 'pr', 'commit', 'branch', 'file']),
  /** An issue or pull request number, a commit sha, a branch name or a file path. */
  id: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  state: z.string().optional(),
  origin: z.enum(['created', 'mentioned']).optional(),
  source: z.enum(['git-output', 'gh-output', 'megabrain-output', 'text']).optional(),
  firstAt: z.string().optional(),
  lastAt: z.string().optional(),
  count: z.number().int().positive().optional(),
})
export const knowledgeTopicSummarySchema = z.looseObject({
  id: z.string(),
  /** The repository path. */
  project: z.string(),
  title: z.string(),
  kind: knowledgeKindSchema,
  status: knowledgeStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Old titles, kept for search and merges. */
  aliases: z.array(z.string()),
  /** One line of the overview. */
  overview: z.string(),
  /** The chats that built the topic. */
  chats: z.array(z.string()),
  refs: z.array(knowledgeRefSchema),
  /** Key messages plus chats: how much work went into the topic. */
  activity: z.number(),
})
export const knowledgeListSchema = z.looseObject({
  projects: z.array(z.looseObject({ repo: z.string(), project: z.string(), enabled: z.boolean(), topics: z.array(knowledgeTopicSummarySchema) })),
})
export const knowledgeSearchSchema = z.looseObject({ results: z.array(knowledgeTopicSummarySchema.extend({ score: z.number() })) })
export const knowledgeDecisionSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  why: z.string(),
  at: z.string(),
  chatId: z.string(),
  /** The decision that replaced this one; a decision is never deleted. */
  supersededBy: z.string().nullable().optional(),
})
export const knowledgeKeyMessageSchema = z.looseObject({ chatId: z.string(), eventCursor: z.string(), at: z.string(), role: z.string(), text: z.string(), why: z.string() })
export const knowledgeChatSchema = z.looseObject({
  id: z.string(),
  title: z.string().nullable(),
  summary: z.string(),
  agent: z.string(),
  model: z.string().nullable(),
  branch: z.string(),
  worktree: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  topics: z.array(z.string()),
  refs: z.array(knowledgeRefSchema),
  /** The chat that dispatched this one, for a dispatch worker. */
  parent: z.string().optional(),
  lastMessages: z.array(z.looseObject({ role: z.string(), text: z.string(), at: z.string() })),
})
export const knowledgeTopicSchema = knowledgeTopicSummarySchema.extend({
  /** Markdown, each. */
  sections: z.looseObject({ overview: z.string(), state: z.string(), pitfalls: z.string(), open: z.string() }),
  decisions: z.array(knowledgeDecisionSchema),
  keyMessages: z.array(knowledgeKeyMessageSchema),
  chatRecords: z.array(knowledgeChatSchema),
})
export const knowledgeTranscriptSchema = z.looseObject({
  chat: knowledgeChatSchema.omit({ lastMessages: true }),
  /** The distilled conversation: person and agent messages in full, each tool call as one line. */
  events: z.array(z.looseObject({ cursor: z.string(), at: z.string(), role: z.enum(['person', 'agent', 'tool']), text: z.string() })),
})

export type KnowledgeKind = z.infer<typeof knowledgeKindSchema>
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>
export type KnowledgeRef = z.infer<typeof knowledgeRefSchema>
export type KnowledgeTopicSummary = z.infer<typeof knowledgeTopicSummarySchema>
export type KnowledgeList = z.infer<typeof knowledgeListSchema>
export type KnowledgeSearch = z.infer<typeof knowledgeSearchSchema>
export type KnowledgeDecision = z.infer<typeof knowledgeDecisionSchema>
export type KnowledgeChat = z.infer<typeof knowledgeChatSchema>
export type KnowledgeTopic = z.infer<typeof knowledgeTopicSchema>
export type KnowledgeTranscript = z.infer<typeof knowledgeTranscriptSchema>
