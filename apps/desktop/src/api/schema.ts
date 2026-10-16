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
export const chainStepSchema = z.looseObject({
  agent: z.string(),
  model: z.string(),
  effort: z.string().optional(),
  until: z.looseObject({ usedPercent: z.number(), window: z.string() }).optional(),
})
export const chainSchema = z.looseObject({
  name: z.string(),
  when: z.record(z.string(), z.unknown()),
  steps: z.array(chainStepSchema),
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
      /** True for the newest generation of its family; absent from an older CLI. */
      current: z.boolean().optional(),
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
export const transcriptImageSchema = z.union([z.object({ path: z.string() }), z.object({ dataUrl: z.string() })])

export const transcriptEventSchema = z.looseObject({
  id: z.string(),
  at: z.string().nullable(),
  kind: z.enum(['user', 'assistant', 'thinking', 'tool-call', 'tool-result', 'system', 'approval']),
  text: z.string(),
  /** On a native chat's assistant or thinking event: the message its streamed chunks belonged to. */
  messageId: z.string().optional(),
  tool: z.looseObject({ name: z.string(), input: z.string().optional(), status: z.enum(['ok', 'error']).optional() }).optional(),
  /** On a user event: the images it carried, a local file or inline; the text keeps an [Image #N] marker where each was. */
  images: z.array(transcriptImageSchema).optional(),
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
export const nativeChatStateSchema = z.enum(['starting', 'idle', 'working', 'waiting-approval', 'stopped', 'error'])
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
// One line of megabrain chat events <id> --since <cursor> --follow --json.
export const chatEventLineSchema = z.looseObject({
  cursor: z.string(),
  chat: nativeChatSchema.optional(),
  event: chatEventSchema.optional(),
  approval: chatApprovalSchema.optional(),
})
// A part of a message: text and images in order, so an image can sit in the middle of the text.
export const messagePartSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({ type: z.literal('image'), path: z.string() }),
])
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
})

export const sendResultSchema = z.looseObject({ delivered: z.boolean(), channel: z.string(), detail: z.string().optional() })

// `megabrain code open <root> --json`: a local VS Code (openvscode-server) for one worktree or
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
export type Chain = z.infer<typeof chainSchema>
export type ChainStep = z.infer<typeof chainStepSchema>
export type UsageReading = z.infer<typeof usageReadingSchema>
export interface AdmissionPolicy {
  maxAgents?: number
  minAvailableMib?: number
  maxPressure?: 'normal' | 'elevated'
  maxContainerSuites?: number
}
export type GithubRepository = z.infer<typeof githubRepositorySchema>
export type GithubCheck = z.infer<typeof githubCheckSchema>
export type GithubPullRequest = z.infer<typeof githubPullRequestSchema>
export type GithubIssue = z.infer<typeof githubIssueSchema>
export type GithubPullRequestList = z.infer<typeof githubPullRequestListSchema>
export type GithubIssueList = z.infer<typeof githubIssueListSchema>
export type GithubDetail = z.infer<typeof githubDetailSchema>
export type Project = z.infer<typeof projectsSchema>[number]
export type ProjectWorktree = z.infer<typeof projectWorktreeSchema>
export type ProjectSession = z.infer<typeof projectSessionSchema>
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
export type CodeServer = z.infer<typeof codeServerSchema>
export type TranscriptEvent = z.infer<typeof transcriptEventSchema>
export type TranscriptImage = z.infer<typeof transcriptImageSchema>
export type CodeEntry = z.infer<typeof codeEntrySchema>
export type CodeFile = z.infer<typeof codeFileSchema>
export type CodeChange = z.infer<typeof codeChangeSchema>
export type CodeDiff = z.infer<typeof codeDiffSchema>
export type ChatRead = z.infer<typeof chatReadSchema>
export type ReplyResult = z.infer<typeof replyResultSchema>

const projectScriptSchema = z.object({ command: z.string(), source: z.enum(['saved', 'detected']) }).nullable()

/** `megabrain repo scripts <root> --json`: a project's run, build and install commands, shared by its worktrees. */
export const projectScriptsSchema = z.object({
  repo: z.string(),
  scripts: z.object({ run: projectScriptSchema, build: projectScriptSchema, install: projectScriptSchema }),
})
export type ProjectScripts = z.infer<typeof projectScriptsSchema>
