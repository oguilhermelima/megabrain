import { z } from 'zod'

// What the app reads from the megabrain CLI. Each schema names only the fields the app uses and lets
// the rest through, so a new CLI field never breaks the app while a missing or renamed one shows up
// as a parse error at the boundary instead of an empty screen.

const agentSchema = z.looseObject({
  agent: z.string(),
  label: z.string(),
  installed: z.boolean(),
  configDir: z.string().nullable(),
})

const hostsSchema = z.looseObject({ orca: z.boolean(), superset: z.boolean(), tmux: z.boolean() })
const skillSchema = z.enum(['none', 'global', 'project'])
const yesNoSchema = z.enum(['yes', 'no'])

export const installPlanSchema = z.looseObject({
  version: z.string(),
  hosts: hostsSchema,
  agents: z.array(agentSchema),
  modules: z.array(
    z.looseObject({
      module: z.string(),
      label: z.string(),
      hint: z.string(),
      group: z.string(),
      selectedByDefault: z.boolean(),
      unavailable: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  defaults: z.looseObject({ agents: z.array(z.string()), skill: skillSchema, tmux: yesNoSchema, modules: z.array(z.string()) }),
  previous: z
    .looseObject({ agents: z.array(z.string()), skill: skillSchema, tmux: yesNoSchema, modules: z.array(z.string()) })
    .nullable(),
})

export const installEventSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('intro'), version: z.string(), hosts: hostsSchema, agents: z.array(agentSchema) }),
  z.looseObject({
    type: z.literal('step'),
    module: z.string().optional(),
    label: z.string(),
    state: z.enum(['start', 'done', 'fail']),
    message: z.string().optional(),
  }),
  z.looseObject({ type: z.literal('info'), message: z.string() }),
  z.looseObject({ type: z.literal('warn'), message: z.string() }),
  z.looseObject({ type: z.literal('confirm'), message: z.string(), answer: z.boolean() }),
  z.looseObject({
    type: z.literal('result'),
    ok: z.boolean(),
    message: z.string(),
    configured: z.array(z.string()),
    failed: z.array(z.looseObject({ module: z.string(), message: z.string() })),
  }),
])

export const moduleResultSchema = z.looseObject({ module: z.string(), action: z.string(), ok: z.boolean(), message: z.string() })

export const doctorReportSchema = z.array(z.looseObject({ module: z.string(), status: z.string(), reason: z.string() }))

const findingSchema = z.looseObject({
  cause: z.string(),
  resetAt: z.string().optional(),
  errorText: z.string().optional(),
  lastLines: z.string().optional(),
  recommendation: z.string().optional(),
})

const dispatchSchema = z.looseObject({
  dispatchId: z.string(),
  state: z.string(),
  agent: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  worktreePath: z.string().nullable().optional(),
  chatName: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  owner: z.enum(['mine', 'foreign', 'unknown']),
  parentSessionId: z.string().nullable().optional(),
  parentHost: z.string().nullable().optional(),
  // The child's own agent session, when megabrain has seen it (claude:<uuid>, codex:<thread>, …).
  agentSessionId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  supervision: z.object({ lastCheck: z.string().nullable(), finding: findingSchema.nullable() }),
})

export const statusSchema = z.looseObject({
  generatedAt: z.string(),
  context: z.looseObject({ host: z.string() }).nullable(),
  machine: z
    .looseObject({
      totalMemoryBytes: z.number(),
      availableMemoryBytes: z.number(),
      pressure: z.string(),
      swapUsedBytes: z.number(),
      loadAverage1: z.number(),
      cpuCount: z.number(),
    })
    .nullable(),
  supervisor: z.object({ watcher: z.object({ running: z.boolean(), pid: z.number().nullable() }) }),
  dispatches: z.array(dispatchSchema),
  queue: z.array(
    z.looseObject({ id: z.string(), kind: z.string(), dispatch: z.string(), type: z.string(), createdAt: z.string(), state: z.string(), text: z.string() }),
  ),
  processes: z.array(z.looseObject({ name: z.string() })),
  resources: z.object({ history: z.boolean(), admission: z.looseObject({}).nullable() }),
  deliveryChannels: z.array(z.looseObject({ agent: z.string(), channel: z.string(), status: z.string() })),
})

// `megabrain settings --json`: everything the Settings window shows, in one read. Writes go through
// the existing verbs (resources policy set|off, resources enable|disable, supervise, chain limits
// --notice-on|--notice-off|--notice-interval|--enable|--disable, chain save|delete, model refresh,
// terminal default) and the window re-reads settings afterwards.
// A chain's `when` and a step's `when` are rules (chains.json, backward compatible): a Condition, whose
// fields must all hold and each take one value or a list meaning any of them, or {all}, {any} or {not}
// of further rules. The app reads them loosely; the CLI (chain save --dry-run) is the authority on
// whether one is valid, and settings/chain-rules.ts checks the grammar locally for instant feedback.
export type RuleValues = string | string[]
export interface UsageCondition {
  provider: string
  window: '5h' | 'weekly'
  below?: number
  above?: number
}
export interface TimeCondition {
  /** mon, tue, wed, thu, fri, sat, sun. */
  days?: string[]
  /** Local time, HH:MM. */
  from?: string
  to?: string
}
export interface Condition {
  parentAgent?: RuleValues
  parentModel?: RuleValues
  parentEffort?: RuleValues
  /** Repository name or path; a glob. */
  repo?: RuleValues
  branch?: RuleValues
  /** A glob on the dispatch label. */
  label?: RuleValues
  usage?: UsageCondition
  time?: TimeCondition
}
export type Rule = Condition | { all: Rule[] } | { any: Rule[] } | { not: Rule }
const ruleSchema = z.custom<Rule>((value) => typeof value === 'object' && value !== null && !Array.isArray(value), 'expected a rule object')

export const chainStepSchema = z.looseObject({
  agent: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  until: z.looseObject({ usedPercent: z.number(), window: z.string() }).optional(),
  /** The step is skipped unless this rule matches. */
  when: ruleSchema.optional(),
  /** Set by `settings --json` when the model is no longer in the registry; never saved back. */
  stale: z.boolean().optional(),
  reason: z.string().optional(),
  suggested: z.looseObject({ model: z.string(), effort: z.string().optional() }).nullable().optional(),
})
export const chainSchema = z.looseObject({
  name: z.string(),
  when: ruleSchema,
  steps: z.array(chainStepSchema),
  /** Higher wins among matching chains; absent means 0. */
  priority: z.number().optional(),
})
// `chain explain --json`: every chain with whether it matched and why, the chosen one, and its steps.
// Step indexes are 1-based on the command line; the adapter turns them into array positions.
export const chainExplainSchema = z.looseObject({
  candidates: z.array(
    z.looseObject({
      name: z.string(),
      matched: z.boolean(),
      specificity: z.number(),
      priority: z.number(),
      reasons: z.union([z.string().transform((reason) => [reason]), z.array(z.string())]),
    }),
  ),
  chosen: z.string().nullable(),
  steps: z.array(z.looseObject({ index: z.number(), step: chainStepSchema, skipped: z.boolean(), reason: z.string().nullable().optional() })),
})
// `chain save ... --dry-run --json`: exit 0 when ok, 2 when invalid, nothing written either way.
export const chainValidationSchema = z.looseObject({
  ok: z.boolean(),
  errors: z.array(z.looseObject({ path: z.string(), message: z.string() })),
})
export const usageReadingSchema = z.looseObject({
  provider: z.string(),
  window: z.string(),
  status: z.string(),
  usedPercent: z.number().nullable(),
  /** Unix seconds as a string, as chain limits reports it. */
  resetsAt: z.string().nullable(),
  fetchedAt: z.number().nullable(),
  reason: z.string(),
  /** Unix seconds of the next live attempt, when the status is stale; absent from an older CLI. */
  retryAt: z.number().nullable().optional(),
})
export const settingsSchema = z.looseObject({
  /** Engine for embedded terminals; absent means native. */
  terminalEngine: z.enum(['native', 'tmux']).optional(),
  supervisor: z.looseObject({ running: z.boolean(), pid: z.number().nullable() }),
  resources: z.looseObject({
    historyEnabled: z.boolean(),
    /** null when no admission policy is set. */
    policy: z
      .looseObject({
        maxAgents: z.number().nullable(),
        minAvailableMib: z.number().nullable(),
        maxPressure: z.enum(['normal', 'elevated']).nullable(),
        maxContainerSuites: z.number().nullable(),
      })
      .nullable(),
  }),
  limits: z.looseObject({
    /** Providers whose live usage reading is enabled. */
    enabledProviders: z.array(z.string()),
    notice: z.looseObject({ enabled: z.boolean(), intervalSeconds: z.number() }),
    readings: z.array(usageReadingSchema),
  }),
  chains: z.array(chainSchema),
  models: z.array(
    z.looseObject({
      agent: z.string(),
      model: z.string(),
      reasoning: z.looseObject({ levels: z.array(z.string()) }),
      /** How people say the model, for example Opus 5.5; absent from an older CLI. */
      name: z.string().optional(),
      /** Token windows the model supports, the default first; absent from an older CLI. */
      contextWindows: z.array(z.number()).optional(),
      /** active, retired or deprecated; absent from an older CLI. */
      status: z.string().optional(),
      /** What the agent's CLI says the model is for; null or absent when it says nothing. */
      description: z.string().nullable().optional(),
    }),
  ),
  terminal: z.looseObject({ default: z.string().nullable(), detected: z.string().nullable(), available: z.array(z.string()) }),
})

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

// `megabrain repo github [--owner <login>] --json`: repositories the person can clone.
export const githubRepositorySchema = z.looseObject({
  nameWithOwner: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  isPrivate: z.boolean(),
  updatedAt: z.string().nullable(),
  /** Absent from an older CLI. */
  primaryLanguage: z.looseObject({ name: z.string() }).nullable().optional(),
  stargazerCount: z.number().optional(),
})

// `megabrain repo github --orgs --json`: the signed-in account first, then its organisations.
export const githubOwnerSchema = z.looseObject({
  login: z.string(),
  kind: z.enum(['user', 'organization']),
  avatarUrl: z.string().nullable(),
})

// `megabrain repo discover [--roots <paths>] --json`: git repositories on disk that are not
// registered, newest commit first.
export const discoveredRepositorySchema = z.looseObject({
  name: z.string(),
  path: z.string(),
  /** null when HEAD is detached. */
  branch: z.string().nullable(),
  remote: z.string().nullable(),
  /** ISO 8601; null for a repository without commits. */
  lastCommitAt: z.string().nullable(),
  root: z.string(),
})

// `megabrain github prs|issues|pr|issue <repo> --json`: a repository's pull requests and issues as
// gh reports them, normalized by the CLI (lower-case states, one state per check, comment counts).
// Lists are light pages; checks, review decision and line counts come with one pull request's detail.
const githubPersonSchema = z.looseObject({ login: z.string(), name: z.string().nullable(), isBot: z.boolean() })
const githubLabelSchema = z.looseObject({ name: z.string(), color: z.string(), description: z.string() })
const githubRepositoryRefSchema = z.looseObject({ nameWithOwner: z.string(), url: z.string(), path: z.string() })

export const githubCheckSchema = z.looseObject({
  name: z.string(),
  state: z.enum(['success', 'failure', 'pending', 'skipped', 'neutral']),
})

export const githubPullRequestSchema = z.looseObject({
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  isDraft: z.boolean(),
  author: githubPersonSchema.nullable(),
  labels: z.array(githubLabelSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  url: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  comments: z.number(),
})

export const githubIssueSchema = z.looseObject({
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  author: githubPersonSchema.nullable(),
  labels: z.array(githubLabelSchema),
  assignees: z.array(z.looseObject({ login: z.string(), name: z.string().nullable() })),
  createdAt: z.string(),
  updatedAt: z.string(),
  url: z.string(),
  comments: z.number(),
  milestone: z.looseObject({ title: z.string(), dueOn: z.string().nullable() }).nullable(),
})

/** One page: `after` is the cursor it was asked from, `nextCursor` the one for the page after (null on the last). */
const githubListing = <T extends z.ZodType>(item: T) =>
  z.looseObject({
    repository: githubRepositoryRefSchema,
    state: z.string(),
    limit: z.number(),
    after: z.string().nullable(),
    fetchedAt: z.string(),
    /** Every state's total (open, closed, merged for pull requests, all), not just this page's. */
    counts: z.record(z.string(), z.number()),
    totalCount: z.number(),
    nextCursor: z.string().nullable(),
    items: z.array(item),
  })

export const githubPullRequestListSchema = githubListing(githubPullRequestSchema)
export const githubIssueListSchema = githubListing(githubIssueSchema)

// `megabrain github pr|issue <repo> <number> --json`: the body (markdown) and the comments, and for a
// pull request its review decision, checks and line counts.
export const githubDetailSchema = z.looseObject({
  repository: githubRepositoryRefSchema,
  number: z.number(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  url: z.string(),
  author: githubPersonSchema.nullable(),
  createdAt: z.string().nullable(),
  body: z.string(),
  comments: z.array(z.looseObject({ author: githubPersonSchema.nullable(), body: z.string(), createdAt: z.string(), url: z.string() })),
  /** null when the repository asks for no review. */
  reviewDecision: z.enum(['approved', 'changes_requested', 'review_required']).nullable().optional(),
  checks: z.array(githubCheckSchema).optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  /** A pull request's branch and the one it merges into, when the CLI reports them. */
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
})

// `megabrain github pr-files <repo> <number> --json`: the files a pull request changes, each with
// gh's unified patch (null when GitHub sends none, as for a binary or a very large file).
export const githubPullRequestFileSchema = z.looseObject({
  path: z.string(),
  previousPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'removed', 'renamed']),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().nullable(),
  /** Whether the viewer marked the file viewed on GitHub; absent from an older CLI. */
  viewed: z.boolean().optional(),
})

// `megabrain github pr-files <repo> <number> --page <k> --per-page <m> --no-patch --json`: one page of
// the changed files without their patches, and how many files the pull request changes in all.
// `github pr-file <repo> <number> <path> --json` then gives one file with its patch.
export const githubPullRequestFilesPageSchema = z.looseObject({
  number: z.number(),
  total: z.number(),
  page: z.number(),
  perPage: z.number(),
  files: z.array(githubPullRequestFileSchema.extend({ patch: z.string().nullable().optional() }).transform((file) => ({ ...file, patch: file.patch ?? null }))),
})

// `megabrain github threads <repo> <number> --json`: the review threads on the diff. line is null for
// a thread on the whole file; isOutdated when the line it was left on has changed since.
export const githubReviewThreadSchema = z.looseObject({
  id: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  side: z.enum(['LEFT', 'RIGHT']).catch('RIGHT'),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.array(z.looseObject({ id: z.string(), author: githubPersonSchema.nullable(), body: z.string(), createdAt: z.string() })),
})

// `megabrain github image <repo> <url> --json`: a picture a body links from a GitHub repository,
// read through gh's API so a private repository's file shows; data is the file as base64.
export const githubImageSchema = z.looseObject({
  contentType: z.string(),
  size: z.number(),
  data: z.string(),
})

/** A person or, with isTeam, a team (login org/team-slug) asked for a review or able to give one. */
export const githubReviewerSchema = githubPersonSchema.extend({ isTeam: z.boolean().optional() })

const lowered = z.string().transform((value) => value.toLowerCase())

// `megabrain github reviewers <repo> <number> --json`: who is asked to review, the reviews given, and
// what GitHub says about merging (mergeable, mergeStateStatus) and the checks the base branch requires.
export const githubReviewersSchema = z.looseObject({
  requested: z.array(githubReviewerSchema),
  reviews: z.array(z.looseObject({ author: githubPersonSchema.nullable(), state: lowered, submittedAt: z.string().nullable() })),
  /** mergeable, conflicting or unknown. */
  mergeable: lowered.nullable(),
  /** clean, blocked, behind, dirty, draft, has_hooks, unstable or unknown. */
  mergeStateStatus: lowered.nullable(),
  reviewDecision: lowered.nullable(),
  requiredChecks: z.array(z.looseObject({ name: z.string(), state: githubCheckSchema.shape.state.catch('pending') })),
})

/** The review `megabrain github review` submits: a verdict, its summary and the inline comments on the diff. */
export type GithubReviewEvent = 'approve' | 'request-changes' | 'comment'
export interface GithubReviewComment {
  path: string
  line: number
  /** LEFT comments on the old side of the diff (a removed line), RIGHT on the new side. */
  side: 'LEFT' | 'RIGHT'
  body: string
}
export interface GithubReview {
  event: GithubReviewEvent
  body: string
  comments?: GithubReviewComment[]
}
export type GithubMergeMethod = 'merge' | 'squash' | 'rebase'

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

// `megabrain orchestrate transcript <dispatch> | --session <agent:id> [--since <cursor>] --operator --json`:
// the agent's own session log as ordered events. `cursor` is opaque; passing it back as --since
// returns only newer events. `source` "terminal" means no session log was readable and the events
// are the pane scrollback as one system event.
// A part of a message: text and images in order, so an image can sit in the middle of the text.
export const messagePartSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({ type: z.literal('image'), path: z.string() }),
])
export const transcriptImageSchema = z.union([z.object({ path: z.string() }), z.object({ dataUrl: z.string() })])

export const transcriptEventSchema = z.looseObject({
  id: z.string(),
  at: z.string().nullable(),
  kind: z.enum(['user', 'assistant', 'thinking', 'tool-call', 'tool-result', 'system', 'approval']),
  text: z.string(),
  /** On a native chat's assistant or thinking event: the message its streamed chunks belonged to. */
  messageId: z.string().optional(),
  tool: z.looseObject({ name: z.string(), input: z.string().optional(), status: z.enum(['ok', 'error']).optional() }).optional(),
  /** On a native chat's event that a subagent produced (its thinking, text, tool calls and results): that subagent's id. */
  parentId: z.string().optional(),
  // On the tool call that starts a subagent (no status) and on the tool result that ends it, whose text is
  // its result. A status this app does not know reads as none, so the subagent still shows.
  subagent: z
    .looseObject({ id: z.string(), type: z.string().optional(), description: z.string().optional(), status: z.enum(['completed', 'failed', 'stopped']).optional().catch(undefined) })
    .optional(),
  /** On a user event: the images it carried, a local file or inline; the text keeps an [Image #N] marker where each was. */
  images: z.array(transcriptImageSchema).optional(),
  /** On a native chat's user event with images: its text and images in the order sent, images[k] being the k-th image part. Older events have none. */
  parts: z.array(messagePartSchema).optional().catch(undefined),
  // Set when the event is a message relayed between chats: a parent's brief or reply inside the
  // child's log ("parent"), or a child's notice or question inside the parent's log ("child").
  origin: z
    .looseObject({ kind: z.enum(['parent', 'child']), label: z.string(), dispatchId: z.string().nullable(), sessionId: z.string().nullable() })
    .optional(),
  // Set on a system event built from a megabrain notice (finished, has a question, is stuck, ...);
  // the text stays the notice line as before. dispatchId is the full id or its 8-character suffix.
  // A kind or agent this app does not know reads as "other" and no agent rather than failing the transcript.
  notice: z
    .looseObject({
      kind: z.enum(['finished', 'ask', 'stuck', 'failed', 'limit', 'other']).catch('other'),
      agent: z.enum(['claude', 'codex', 'grok', 'agy']).nullable().catch(null),
      label: z.string().nullable(),
      dispatchId: z.string().nullable(),
      summary: z.string(),
    })
    .optional(),
})

// `megabrain send --session <agent:id> --text <text> --operator --json`: a message to any agent
// session, including ones megabrain did not start.
// `megabrain commands --agent <agent> --cwd <path> --json`: the slash commands that agent offers
// in that folder: built-in ones and the person's and project's own (Claude .claude/commands and
// skills, Codex prompts, ...).
export const slashCommandSchema = z.looseObject({
  name: z.string(),
  description: z.string().nullable(),
  source: z.enum(['builtin', 'user', 'project', 'skill', 'plugin']),
  argumentHint: z.string().nullable().optional(),
})

// `megabrain orchestrate queue <dispatch> --operator --json`: messages waiting to reach a chat.
export const queuedMessageSchema = z.looseObject({
  id: z.string(),
  dispatch: z.string(),
  type: z.string(),
  createdAt: z.string(),
  state: z.string(),
  text: z.string(),
})

// Native chats: conversations megabrain itself owns through each agent's protocol (Claude
// stream-json, Codex app-server), kept alive by megabrain chatd while the app is closed.
export const nativeChatStateSchema = z.enum(['starting', 'idle', 'working', 'waiting-approval', 'suspended', 'stopped', 'error'])
export const nativeChatSchema = z.looseObject({
  id: z.string(),
  agent: z.string(),
  model: z.string().nullable(),
  cwd: z.string(),
  title: z.string().nullable(),
  state: nativeChatStateSchema,
  /** Who drives the conversation now: the protocol (chat) or the agent's own TUI (terminal). */
  mode: z.enum(['chat', 'terminal']),
  /** The agent's own session or thread id, for resume. */
  agentSessionId: z.string().nullable(),
  createdAt: z.string(),
  lastActivityAt: z.string().nullable(),
  error: z.string().nullable().optional(),
  /** Tokens in the conversation's current context and the model's window, when the agent reports them. */
  contextTokens: z.number().nullable().optional(),
  contextWindow: z.number().nullable().optional(),
  /** The slash command names the agent reported when it started (Claude's init), absent before. */
  slashCommands: z.array(z.string()).optional(),
})
// A pending approval inside a native chat; it arrives as a transcript event of kind "approval".
export const chatApprovalSchema = z.looseObject({
  id: z.string(),
  tool: z.string(),
  input: z.string(),
  reason: z.string().nullable().optional(),
  decisions: z.array(z.enum(['allow', 'allow-session', 'deny'])),
})
// A change of the chat's state, sent on every change and once at the start of every follow, and
// stored in history. `text` is the state; one this app does not know is ignored. turnStartedAt is set
// while a turn runs.
export const chatStateEventSchema = z.looseObject({
  id: z.string(),
  at: z.string().nullable(),
  kind: z.literal('state'),
  text: z.string(),
  turnStartedAt: z.string().nullable().optional(),
})
// A chunk of an assistant or thinking message still being generated. Sent to followers only and never
// stored: the complete event that follows carries the same messageId and replaces the chunks.
export const chatDeltaEventSchema = z.looseObject({
  kind: z.literal('delta'),
  stream: z.enum(['assistant', 'thinking']),
  messageId: z.string(),
  text: z.string(),
})
export const chatEventSchema = z.union([chatStateEventSchema, chatDeltaEventSchema, z.lazy(() => transcriptEventSchema)])
// A message sent while the native chat's turn ran, waiting in its queue (`chat queue ... --json`).
export const chatQueueItemSchema = z.looseObject({
  id: z.string(),
  parts: z.array(messagePartSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})
// One line of megabrain chat events <id> --since <cursor> --follow --json. `queue` is the whole
// queue: on the first line of every follow and on a live line after each change.
export const chatEventLineSchema = z.looseObject({
  cursor: z.string(),
  chat: nativeChatSchema.optional(),
  event: chatEventSchema.optional(),
  approval: chatApprovalSchema.optional(),
  queue: z.array(chatQueueItemSchema).optional(),
})
// `agent defaults --json`: each agent's default model and effort from its own config (null when it
// sets none), and the shell a new terminal opens.
export const agentDefaultsSchema = z.looseObject({
  agents: z.array(z.looseObject({ agent: z.string(), model: z.string().nullable(), effort: z.string().nullable() })),
  shell: z.string(),
})
export type AgentDefaults = z.infer<typeof agentDefaultsSchema>
// `agent command --json`: the command line that starts an agent's own TUI.
export const agentCommandSchema = z.looseObject({ agent: z.string(), argv: z.array(z.string()).min(1) })
// `sessions history --cwd <path> --json`: past sessions started in a folder, newest first, read from
// each agent's own storage; messageCount is null when the log does not say.
export const historySessionSchema = z.looseObject({
  agent: z.enum(['claude', 'codex', 'grok', 'agy']),
  id: z.string(),
  title: z.string(),
  startedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  messageCount: z.number().nullable(),
})
export const sessionHistorySchema = z.array(historySessionSchema)
// Embedded terminals: the native engine is a PTY the app owns (dies with the app); tmux attaches
// a PTY to a session on megabrain's own tmux server (survives the app).
export const terminalEngineSchema = z.enum(['native', 'tmux'])
export const terminalSessionSchema = z.looseObject({
  id: z.string(),
  engine: terminalEngineSchema,
  cwd: z.string(),
  title: z.string(),
  /** tmux engine only: the session on megabrain's tmux server. */
  tmuxSession: z.string().nullable(),
  /** Native engine only: the process the PTY started; absent from an older app. */
  pid: z.number().nullable().optional(),
})

export const sendResultSchema = z.looseObject({ delivered: z.boolean(), channel: z.string(), detail: z.string().optional() })

// `megabrain code open <root> --json`: a local Code editor (code-server) for one worktree or
// repository, started on demand and reused; `code stop <root>` ends it.
export const codeServerSchema = z.looseObject({ root: z.string(), url: z.string(), port: z.number(), pid: z.number() })

export const transcriptSchema = z.looseObject({
  dispatchId: z.string().nullable(),
  sessionId: z.string().nullable(),
  agent: z.string(),
  source: z.enum(['claude', 'codex', 'grok', 'agy', 'terminal']),
  cursor: z.string(),
  events: z.array(transcriptEventSchema),
})

// The code browser, from the native side (src-tauri/src/code.rs): read-only, limited to the
// worktrees and repositories `megabrain worktree list --json` names.
export const codeEntrySchema = z.looseObject({ path: z.string(), kind: z.enum(['file', 'dir']), size: z.number().nullable() })
export const codeFileSchema = z.looseObject({ path: z.string(), text: z.string().nullable(), binary: z.boolean(), tooLarge: z.boolean() })
export const codeChangeSchema = z.looseObject({ path: z.string(), status: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked']) })
export const codeDiffSchema = z.looseObject({
  path: z.string(),
  original: z.string(),
  modified: z.string(),
  binary: z.boolean().optional(),
  tooLarge: z.boolean().optional(),
})

// What a branch committed since it left its base (the worktree's parent branch, else origin's
// default branch); base and mergeBase are null when neither resolves or they share no history.
export const branchChangesSchema = z.looseObject({ base: z.string().nullable(), mergeBase: z.string().nullable(), changes: z.array(codeChangeSchema) })

export const chatReadSchema = z.looseObject({ dispatchId: z.string(), source: z.string(), truncated: z.boolean(), text: z.string() })

export const replyResultSchema = z.looseObject({ dispatchId: z.string(), status: z.string(), nudge: z.string() })

// `megabrain db show <dispatch-id-or-suffix> --json`: the dispatch record with its message history,
// oldest first; `from` is "child" for what the child sent (received, ask, done, stalled, ...).
export const dispatchMessagesSchema = z.looseObject({
  messages: z.array(z.looseObject({ from: z.string(), type: z.string(), text: z.string() })),
})

export type InstallPlan = z.infer<typeof installPlanSchema>
export type PlanModule = InstallPlan['modules'][number]
export type InstallEvent = z.infer<typeof installEventSchema>
export type ResultEvent = Extract<InstallEvent, { type: 'result' }>
export type ModuleResult = z.infer<typeof moduleResultSchema>
export type DoctorReport = z.infer<typeof doctorReportSchema>
export type Status = z.infer<typeof statusSchema>
export type Dispatch = Status['dispatches'][number]
export type Worktree = z.infer<typeof worktreeListSchema>[number]
export type Repository = z.infer<typeof repositorySchema>
export type Settings = z.infer<typeof settingsSchema>
/** The top-level keys of `settings --json`; `--only` reads some of them. */
export type SettingsKey = 'terminalEngine' | 'supervisor' | 'resources' | 'limits' | 'chains' | 'models' | 'terminal'
export type Chain = z.infer<typeof chainSchema>
export type ChainStep = z.infer<typeof chainStepSchema>
export type ChainExplain = z.infer<typeof chainExplainSchema>
export type ChainValidation = z.infer<typeof chainValidationSchema>
/** A chain as chains.json stores it, without its name. */
export interface ChainBody {
  when: Rule
  steps: ChainStep[]
  priority?: number
}
/** The dispatch `chain explain` imagines; every field optional. */
export interface ChainExplainInput {
  parentAgent?: string
  parentModel?: string
  parentEffort?: string
  repo?: string
  branch?: string
  label?: string
}
/** One step's changes for `chain step edit`; null removes until or when. */
export interface StepPatch {
  agent?: string
  model?: string
  effort?: string
  until?: ChainStep['until'] | null
  when?: Rule | null
}
export type UsageReading = z.infer<typeof usageReadingSchema>

const tokenKinds = { input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), reasoning: z.number() }

/** `usage stats --json`: token usage per day and provider from the agents' own logs. */
export const usageStatsSchema = z.looseObject({
  range: z.looseObject({ days: z.number().nullable(), from: z.string().nullable(), to: z.string() }),
  prices: z.looseObject({ asOf: z.string(), note: z.string() }),
  totals: z.looseObject({ ...tokenKinds, total: z.number(), sessions: z.number(), turns: z.number(), cost: z.number().nullable(), unpricedTokens: z.number() }),
  daily: z.array(z.looseObject({ date: z.string(), total: z.number(), byProvider: z.record(z.string(), z.number()) })),
  activeDays: z.number(),
  bestDay: z.looseObject({ date: z.string(), total: z.number() }).nullable(),
  cacheShare: z.number().nullable(),
  trackingSince: z.string().nullable(),
  providers: z.array(
    z.looseObject({
      provider: z.string(),
      tracked: z.boolean(),
      ...tokenKinds,
      total: z.number(),
      sessions: z.number(),
      turns: z.number(),
      cost: z.number().nullable(),
      unpricedTokens: z.number(),
      share: z.number(),
      lastModel: z.string().nullable(),
      lastProject: z.string().nullable(),
      lastActiveAt: z.string().nullable(),
    }),
  ),
  models: z.array(z.looseObject({ provider: z.string(), model: z.string(), total: z.number(), cost: z.number().nullable() })),
  projects: z.array(z.looseObject({ project: z.string(), total: z.number() })),
  megabrain: z.looseObject({ dispatches: z.number(), agentSeconds: z.number(), chats: z.number(), since: z.string().nullable() }).nullable(),
})
export type UsageStats = z.infer<typeof usageStatsSchema>
export interface AdmissionPolicy {
  maxAgents?: number
  minAvailableMib?: number
  maxPressure?: 'normal' | 'elevated'
  maxContainerSuites?: number
}
export type GithubRepository = z.infer<typeof githubRepositorySchema>
export type GithubOwner = z.infer<typeof githubOwnerSchema>
export type DiscoveredRepository = z.infer<typeof discoveredRepositorySchema>
export type GithubCheck = z.infer<typeof githubCheckSchema>
export type GithubPullRequest = z.infer<typeof githubPullRequestSchema>
export type GithubIssue = z.infer<typeof githubIssueSchema>
export type GithubPullRequestList = z.infer<typeof githubPullRequestListSchema>
export type GithubIssueList = z.infer<typeof githubIssueListSchema>
export type GithubDetail = z.infer<typeof githubDetailSchema>
export type GithubPullRequestFile = z.infer<typeof githubPullRequestFileSchema>
export type GithubPullRequestFilesPage = z.infer<typeof githubPullRequestFilesPageSchema>
export type GithubReviewThread = z.infer<typeof githubReviewThreadSchema>
export type GithubReviewer = z.infer<typeof githubReviewerSchema>
export type GithubReviewers = z.infer<typeof githubReviewersSchema>
export type GithubImage = z.infer<typeof githubImageSchema>
export type Project = z.infer<typeof projectsSchema>[number]
export type StackShow = z.infer<typeof stackShowSchema>
export type ProjectWorktree = z.infer<typeof projectWorktreeSchema>
export type ProjectSession = z.infer<typeof projectSessionSchema>
export type ProjectAppearance = z.infer<typeof projectAppearanceSchema>
export type ArchivedWorktree = z.infer<typeof archivedWorktreeSchema>
export type HistorySession = z.infer<typeof historySessionSchema>
export type Transcript = z.infer<typeof transcriptSchema>
export type SendResult = z.infer<typeof sendResultSchema>
export type NativeChat = z.infer<typeof nativeChatSchema>
export type ChatApproval = z.infer<typeof chatApprovalSchema>
export type ChatEventLine = z.infer<typeof chatEventLineSchema>
export type ChatEvent = z.infer<typeof chatEventSchema>
export type ChatStateEvent = z.infer<typeof chatStateEventSchema>
export type ChatDeltaEvent = z.infer<typeof chatDeltaEventSchema>
export type MessagePart = z.infer<typeof messagePartSchema>
export type TerminalEngine = z.infer<typeof terminalEngineSchema>
export type TerminalSession = z.infer<typeof terminalSessionSchema>
export type SlashCommand = z.infer<typeof slashCommandSchema>
export type QueuedMessage = z.infer<typeof queuedMessageSchema>
export type ChatQueueItem = z.infer<typeof chatQueueItemSchema>
export type CodeServer = z.infer<typeof codeServerSchema>
export type TranscriptEvent = z.infer<typeof transcriptEventSchema>
export type TranscriptImage = z.infer<typeof transcriptImageSchema>
export type CodeEntry = z.infer<typeof codeEntrySchema>
export type CodeFile = z.infer<typeof codeFileSchema>
export type CodeChange = z.infer<typeof codeChangeSchema>
export type CodeDiff = z.infer<typeof codeDiffSchema>
export type BranchChanges = z.infer<typeof branchChangesSchema>
export type ChatRead = z.infer<typeof chatReadSchema>
export type ReplyResult = z.infer<typeof replyResultSchema>

const projectScriptSchema = z.object({ command: z.string(), source: z.enum(['saved', 'detected']) }).nullable()

/**
 * The port a run command binds and how that was found. `fragment` is the text in the run command
 * that sets it; `override` is what to append to move it, {port} standing for the new one, or null.
 */
export const scriptPortSchema = z.object({
  port: z.number().int(),
  framework: z.string().nullable(),
  source: z.enum(['command', 'script', 'env-file', 'package-json', 'default']),
  detail: z.string(),
  fragment: z.string().nullable(),
  override: z.string().nullable(),
})
export type ScriptPort = z.infer<typeof scriptPortSchema>

/** `megabrain repo scripts <root> --json`: a project's run, build and install commands, shared by its worktrees, and the run's port. */
export const projectScriptsSchema = z.object({
  repo: z.string(),
  scripts: z.object({ run: projectScriptSchema, build: projectScriptSchema, install: projectScriptSchema }),
  port: scriptPortSchema.nullable().optional(),
})
export type ProjectScripts = z.infer<typeof projectScriptsSchema>

/** `megabrain repo run --json`: the managed process a project script runs as. `session` is the tmux session to attach a terminal to. */
export const runScriptSchema = z.object({
  script: z.enum(['run', 'build', 'install']),
  session: z.string(),
  pid: z.number().int(),
  alreadyRunning: z.boolean(),
  port: z.number().int().nullable(),
})
export type RunScriptResult = z.infer<typeof runScriptSchema>

/** One process listening on a port (`megabrain port who`), and the megabrain process or app terminal it runs in, if any. */
export const portListenerSchema = z.object({
  pid: z.number().int(),
  command: z.string(),
  args: z.string(),
  cwd: z.string().nullable(),
  startedAt: z.string().nullable(),
  place: z.object({ root: z.string(), project: z.string(), branch: z.string().nullable() }).nullable(),
  managed: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('proc'), name: z.string(), worktree: z.string() }),
      z.object({ kind: z.literal('app-terminal'), session: z.string(), title: z.string() }),
    ])
    .nullable(),
})
export type PortListener = z.infer<typeof portListenerSchema>

/** `megabrain port who <port> --json`. */
export const portListenersSchema = z.object({ port: z.number().int(), listeners: z.array(portListenerSchema) })
export type PortListeners = z.infer<typeof portListenersSchema>

/** `megabrain port free --from <port> --json`. */
export const portFreeSchema = z.object({ port: z.number().int() })

/** `megabrain port kill <port> --json`. */
export const portKillSchema = z.object({ port: z.number().int(), top: z.number().int(), stopped: z.array(z.number().int()), freed: z.boolean() })

/** `megabrain maestro flows --json`: the worktree's flows under .maestro and maestro, path relative to the worktree. */
export const maestroFlowSchema = z.looseObject({ path: z.string(), name: z.string(), appId: z.string().nullable() })
export type MaestroFlow = z.infer<typeof maestroFlowSchema>

const maestroStateSchema = z.enum(['running', 'passed', 'failed', 'stopped'])

/** `megabrain maestro runs --json`: every run of the worktree, newest first; durationMs is null while it runs. */
export const maestroRunSchema = z.looseObject({
  runId: z.string(),
  flow: z.string(),
  device: z.string(),
  state: maestroStateSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  durationMs: z.number().nullable(),
  artifacts: z.string(),
})
export type MaestroRun = z.infer<typeof maestroRunSchema>

/** One line of `megabrain maestro run --json`: the run starting, a finished step, the verdict. */
export const maestroEventSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('start'), runId: z.string(), flow: z.string(), device: z.string(), artifacts: z.string() }),
  z.looseObject({
    type: z.literal('step'),
    index: z.number().int(),
    command: z.string(),
    status: z.enum(['passed', 'failed', 'skipped']),
    durationMs: z.number(),
    screenshot: z.string().nullable(),
    error: z.string().nullable(),
  }),
  z.looseObject({ type: z.literal('run'), state: maestroStateSchema, runId: z.string(), exitCode: z.number(), durationMs: z.number(), artifacts: z.string() }),
])
export type MaestroEvent = z.infer<typeof maestroEventSchema>

export const simulatorSchema = z.looseObject({ udid: z.string(), name: z.string(), state: z.string() })
export type Simulator = z.infer<typeof simulatorSchema>

/** `megabrain native sim list phone --json`: the available iOS simulators. */
export const simulatorListSchema = z.looseObject({ devices: z.array(simulatorSchema) })
