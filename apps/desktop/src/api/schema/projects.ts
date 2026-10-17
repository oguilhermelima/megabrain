import { z } from 'zod'

// megabrain's own project registry. A project enters it in two ways only: megabrain worked in it
// (spawn or worktree create registers the repository; the first run backfills from history), or the
// person imported it (a local folder or a GitHub clone).
// `megabrain repo list|add <path>|clone <url> [--into <dir>]|remove <name|path> --json`
export const repositorySchema = z.looseObject({
  name: z.string(),
  path: z.string(),
  remote: z.string().nullable(),
  source: z.enum(['megabrain', 'import']),
  addedAt: z.string(),
})

// One agent session found in a worktree, started by megabrain or by hand.
export const projectSessionSchema = z.looseObject({
  agent: z.enum(['claude', 'codex', 'grok', 'agy']),
  /** agent:id, usable with `orchestrate transcript --session`. */
  sessionId: z.string(),
  title: z.string(),
  status: z.enum(['working', 'idle', 'waiting', 'ended']),
  startedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  /** Set when megabrain started this session as a dispatch. */
  dispatchId: z.string().nullable(),
  /** Tokens in the session's current context, when the agent records it. */
  contextTokens: z.number().nullable().optional(),
  /** When the agent's prompt cache expires if nothing happens (Claude: last activity + 1 hour). */
  cacheExpiresAt: z.string().nullable().optional(),
  /** When the agent compacts an idle session on its own (Claude 2.1.299+: last activity + about
   * 54 minutes, only above its idle-compaction token minimum and while idleCompaction is on). */
  idleCompactAt: z.string().nullable().optional(),
  /** The model the session runs, Claude's with [1m] when it has the 1M window; absent from an older CLI. */
  model: z.string().nullable().optional(),
  /** The context window the session really has; absent from an older CLI. */
  contextWindow: z.number().nullable().optional(),
  /** megabrain when megabrain started the session or runs it in a terminal of its own; absent from an older CLI. */
  origin: z.enum(['megabrain', 'external']).optional(),
  /** megabrain when it resumed the session in its own tmux session (`session own`); absent from an older CLI. */
  owner: z.enum(['megabrain', 'external']).optional(),
  /** When owned: the tmux server (`tmux -L`) and session the agent runs in. */
  tmuxServer: z.string().nullable().optional(),
  tmuxSession: z.string().nullable().optional(),
  /** When the app launched it in a native terminal: the process that terminal started. */
  terminalPid: z.number().nullable().optional(),
  /** Who owns the conversation: a chat or terminal of the app, a dispatch's worker, or another app; absent from an older CLI. */
  conversationOwner: z.enum(['app-chat', 'app-terminal', 'dispatch', 'foreign']).optional(),
  /** The chat whose conversation this is, for an app chat. */
  chatId: z.string().nullable().optional(),
})

export const projectWorktreeSchema = z.looseObject({
  path: z.string(),
  /** Branch name, or null when HEAD is detached. */
  branch: z.string().nullable(),
  head: z.string().nullable(),
  primary: z.boolean(),
  parent: z.string().nullable(),
  /** title and isDraft are null when the CLI's cached value predates them, absent from an older CLI. */
  pullRequest: z.looseObject({ number: z.number(), state: z.string(), url: z.string(), title: z.string().nullable().optional(), isDraft: z.boolean().nullable().optional() }).nullable(),
  /** Hidden by the person; the sidebar shows it only under Hidden. */
  hidden: z.boolean().optional(),
  sessions: z.array(projectSessionSchema),
})

// `megabrain stack show --branch <member> --json`: the member's stack with what the projects list
// lacks per branch — review decision, checks and how far its parent moved on. Read in stacks.ts.
export const stackShowSchema = z.looseObject({
  branches: z.array(
    z.looseObject({
      branch: z.string(),
      behindParent: z.number().nullable().optional(),
      pullRequest: z.looseObject({ number: z.number(), reviewDecision: z.string().nullable().optional(), statusCheckRollup: z.array(z.unknown()).nullable().optional() }).nullable().optional(),
    }),
  ),
})

// How the person dressed a project in megabrain only; the repository never changes. picture is
// the path of megabrain's own copy under ~/.megabrain/project-pictures. Read in appearance-model.ts.
export const projectAppearanceSchema = z.looseObject({
  name: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  picture: z.string().nullable().optional(),
})

/** `megabrain settings get project-appearance --json`, by repository path. */
export const projectAppearancesSchema = z.looseObject({ projects: z.record(z.string(), projectAppearanceSchema) })

// One branch whose worktree folder megabrain removed and keeps for later (`worktree archived --json`).
export const archivedWorktreeSchema = z.looseObject({
  repo: z.string(),
  branch: z.string(),
  head: z.string().nullable().optional(),
  archivedAt: z.string(),
  parent: z.string().nullable().optional(),
  pullRequest: z.looseObject({ number: z.number(), state: z.string().optional(), url: z.string().optional() }).nullable().optional(),
})

// `megabrain projects --json`: every registered project with its main checkout first, then its
// worktrees, and the agent sessions in each.
export const projectsSchema = z.array(
  z.looseObject({
    name: z.string(),
    path: z.string(),
    remote: z.string().nullable(),
    source: z.enum(['megabrain', 'import']),
    /** The folder no longer exists or is no longer a git repository. */
    missing: z.boolean(),
    hidden: z.boolean().optional(),
    /** Absent from an older CLI. */
    appearance: projectAppearanceSchema.optional(),
    worktrees: z.array(projectWorktreeSchema),
  }),
)

export const worktreeListSchema = z.array(
  z.looseObject({
    path: z.string(),
    branch: z.string(),
    parent: z.string().nullable().optional(),
    pullRequest: z.looseObject({ number: z.number(), state: z.string(), url: z.string() }).nullable().optional(),
    repository: z.looseObject({ name: z.string(), path: z.string() }).optional(),
  }),
)

export type Project = z.infer<typeof projectsSchema>[number]
export type StackShow = z.infer<typeof stackShowSchema>
export type ProjectWorktree = z.infer<typeof projectWorktreeSchema>
export type ProjectSession = z.infer<typeof projectSessionSchema>
export type ProjectAppearance = z.infer<typeof projectAppearanceSchema>
export type ArchivedWorktree = z.infer<typeof archivedWorktreeSchema>
export type Worktree = z.infer<typeof worktreeListSchema>[number]
export type Repository = z.infer<typeof repositorySchema>
