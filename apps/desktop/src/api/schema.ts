export * from './schema/runtime'
export * from './schema/projects'
export * from './schema/settings'
export * from './schema/artifacts'
export * from './schema/github'
export * from './schema/knowledge'

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
  agentUpdates: z.record(z.string(), z.looseObject({
    agent: z.string(), installed: z.string().nullable(), latest: z.string().nullable(),
    installKind: z.string(), status: z.string(), checkedAt: z.string(),
    lastAttempt: z.looseObject({ at: z.string(), ok: z.boolean(), error: z.string().optional() }).optional(),
  })).optional(),
})

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

// What megabrain read when it answered an info command itself (/status, /usage, /context) for a chat's
// agent. Every field is absent when megabrain does not know it; a limit window this app does not name reads as other.
const infoTokensSchema = z.looseObject({ input: z.number().optional(), output: z.number().optional(), cacheRead: z.number().optional(), cacheWrite: z.number().optional() })
export const infoDataSchema = z.looseObject({
  model: z.string().optional(),
  effort: z.string().optional(),
  approvals: z.string().optional(),
  sandbox: z.string().optional(),
  cwd: z.string().optional(),
  session: z.looseObject({ id: z.string(), startedAt: z.string().optional(), turns: z.number().optional() }).optional(),
  context: z.looseObject({ used: z.number().optional(), window: z.number().optional(), percent: z.number().optional() }).optional(),
  limits: z
    .array(z.looseObject({ label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable().optional(), window: z.enum(['5h', 'weekly', 'monthly', 'other']).catch('other') }))
    .optional(),
  cost: z
    .looseObject({ total: z.number(), currency: z.string().optional(), byModel: z.array(infoTokensSchema.extend({ model: z.string(), cost: z.number().optional() })).optional() })
    .optional(),
  tokens: infoTokensSchema.optional(),
})

export const transcriptEventSchema = z.looseObject({
  id: z.string(),
  /** Agent turn identifier used by native fork and rewind operations. */
  turnId: z.string().optional(),
  at: z.string().nullable(),
  kind: z.enum(['user', 'assistant', 'thinking', 'tool-call', 'tool-result', 'system', 'approval', 'turn-cut', 'background-task', 'command-output', 'rewind']),
  text: z.string(),
  /** On a rewind event: the first event of the removed turn. */
  fromEventId: z.string().optional(),
  /** On a native chat's assistant or thinking event: the message its streamed chunks belonged to. */
  messageId: z.string().optional(),
  /** On an assistant event that is a local command's output (/usage, /cost): the command it answers, slash included; "" when the log does not say. Also on a command-output event. */
  command: z.string().optional(),
  // On a command-output event: an info command megabrain answered itself, for that agent, with what it read
  // as data and the same as plain text. Data this app cannot read is dropped and the text shows instead.
  agent: z.enum(['claude', 'codex', 'grok', 'agy']).optional().catch(undefined),
  source: z.string().optional(),
  data: infoDataSchema.optional().catch(undefined),
  tool: z.looseObject({ name: z.string(), input: z.string().optional(), status: z.enum(['ok', 'error']).optional() }).optional(),
  /** On a native chat's event that a subagent produced (its thinking, text, tool calls and results): that subagent's id. */
  parentId: z.string().optional(),
  // On the tool call that starts a subagent (no status) and on the tool result that ends it, whose text is
  // its result. A status this app does not know reads as none, so the subagent still shows.
  subagent: z
    .looseObject({ id: z.string(), type: z.string().optional(), description: z.string().optional(), status: z.enum(['completed', 'failed', 'stopped']).optional().catch(undefined) })
    .optional(),
  // On a turn-cut event: a turn that ended without the agent finishing it, sent once after any partial text.
  // A reason this app does not know reads as unknown; partial says whether some of the answer had arrived.
  reason: z.enum(['interrupted', 'process-exited', 'error', 'limit', 'unknown']).catch('unknown').optional(),
  detail: z.string().optional(),
  partial: z.boolean().optional(),
  // On a background-task event: work the agent left running past its answer (a background shell, a monitor,
  // a background agent), sent when it starts and on every change of state under the same id. lost means the
  // session or the daemon ended without a final state. A kind this app does not know reads as other.
  backgroundTask: z
    .looseObject({
      id: z.string(),
      kind: z.enum(['shell', 'monitor', 'agent', 'other']).catch('other'),
      label: z.string(),
      state: z.enum(['running', 'completed', 'failed', 'killed', 'lost']),
      startedAt: z.string(),
      endedAt: z.string().nullable().optional(),
      summary: z.string().nullable().optional(),
      exitCode: z.number().nullable().optional(),
    })
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
// stream-json, Codex app-server, Grok ACP, agy stream-json or its followed terminal), kept alive by
// megabrain chatd while the app is closed.
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
  /** Which process holds the agent session now; absent from a daemon that does not report it. */
  owner: z.string().superRefine((owner, context) => {
    if (owner !== 'chat' && owner !== 'terminal' && owner !== 'none') context.addIssue({ code: 'custom', message: 'owner must be chat, terminal or none' })
  }).optional(),
  /** The agent's own session or thread id, for resume. */
  agentSessionId: z.string().nullable(),
  /** Controls which actions the native chat can offer for this agent. */
  capabilities: z.looseObject({
    approvals: z.boolean(), interrupt: z.boolean(), liveModelSwitch: z.boolean(), steer: z.boolean(), structuredTools: z.boolean(),
  }).optional(),
  createdAt: z.string(),
  lastActivityAt: z.string().nullable(),
  error: z.string().nullable().optional(),
  /** Tokens in the conversation's current context and the model's window, when the agent reports them. */
  contextTokens: z.number().nullable().optional(),
  contextWindow: z.number().nullable().optional(),
  /** The slash command names the agent reported when it started (Claude's init), absent before. */
  slashCommands: z.array(z.string()).optional(),
})

export const chatDaemonStatusSchema = z.discriminatedUnion('running', [
  z.looseObject({ running: z.literal(false) }),
  z.looseObject({
    running: z.literal(true), compatible: z.boolean().optional(), pid: z.number().optional(),
    protocol: z.looseObject({ version: z.number(), min: z.number(), max: z.number() }).optional().catch(undefined),
    daemonVersion: z.string().optional(), superseded: z.boolean().optional(), liveChats: z.number().optional(),
    build: z.number().optional(), draining: z.boolean().optional(), working: z.array(z.string()).optional(),
  }),
])
export type ChatDaemonStatus = z.infer<typeof chatDaemonStatusSchema>
export const chatDaemonRetireSchema = z.discriminatedUnion('running', [
  z.looseObject({ running: z.literal(false) }),
  z.looseObject({ running: z.literal(true), retired: z.literal(true), waitedMs: z.number() }),
])
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
  at: z.string().optional(),
})
// What a running turn reports besides its messages, sent to followers only: its output tokens so far, a
// retry the agent waits on (each part when the agent says it), or what it is doing (requesting, compacting).
export const chatProgressEventSchema = z.looseObject({
  kind: z.literal('progress'),
  at: z.string().optional(),
  progress: z.looseObject({
    tokens: z.number().optional(),
    retry: z.looseObject({ attempt: z.number().optional(), maxAttempts: z.number().optional(), delayMs: z.number().optional(), reason: z.string().optional() }).optional(),
    status: z.string().optional(),
  }),
})
// The chat's artifacts changed, sent to followers only (cursor ""): the view lists them again.
export const chatArtifactsEventSchema = z.looseObject({ kind: z.literal('artifacts'), at: z.string().optional() })
// Stored when the last message of the person was edited: every event from fromEventId onward left the
// conversation, and the edited message follows. Applied on replay too, so every viewer agrees.
export const chatRewindEventSchema = z.looseObject({ kind: z.literal('rewind'), fromEventId: z.string(), at: z.string().nullable().optional(), id: z.string().optional() })
export const chatEventSchema = z.union([chatStateEventSchema, chatDeltaEventSchema, chatProgressEventSchema, chatArtifactsEventSchema, chatRewindEventSchema, z.lazy(() => transcriptEventSchema)])
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
  // An event kind this app does not read (a summary, a newer one) leaves the line without one, so its cursor still counts.
  event: chatEventSchema.optional().catch(undefined),
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
// The agent update check: each agent CLI's installed and latest version (null when unknown), how it
// was installed, when it was last checked, and the last update attempt. status is up-to-date,
// update-available, updated, latest-unknown or updating; installKind standalone, npm, brew, native
// or unknown. Kept as strings so a value the app does not know yet reads as unknown, not an error.
export const agentUpdateEntrySchema = z.looseObject({
  agent: z.string(),
  installed: z.string().nullable(),
  latest: z.string().nullable(),
  status: z.string(),
  installKind: z.string(),
  checkedAt: z.string().nullable(),
  lastAttempt: z.looseObject({ at: z.string(), ok: z.boolean(), error: z.string().nullable().optional() }).optional(),
})
export const agentUpdatesSchema = z.looseObject({ agents: z.array(agentUpdateEntrySchema) })
export type AgentUpdateEntry = z.infer<typeof agentUpdateEntrySchema>
export type AgentUpdates = z.infer<typeof agentUpdatesSchema>
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

export const orchestrationGraphSchema = z.looseObject({
  version: z.literal(1), focus: z.string(), root: z.string(),
  nodes: z.array(z.looseObject({
    id: z.string(), kind: z.enum(['coordinator', 'lane']), parent: z.string().nullable(), label: z.string(),
    agent: z.enum(['claude', 'codex', 'grok', 'agy']), model: z.string().nullable(), effort: z.string().nullable(),
    state: z.enum(['starting', 'working', 'asking', 'idle', 'done', 'closed', 'failed', 'stalled']),
    startedAt: z.string(), endedAt: z.string().nullable(), contextPercent: z.number().min(0).max(100).nullable(),
    last: z.looseObject({ type: z.enum(['received', 'ask', 'reply', 'done', 'change', 'supervise', 'stalled']), text: z.string(), at: z.string() }).nullable(),
    finding: z.string().nullable(), unanswered: z.boolean(), worktree: z.string().nullable(), branch: z.string().nullable(),
    commits: z.number().nullable(), chatId: z.string().nullable(), session: z.string().nullable(),
  })),
  events: z.array(z.looseObject({ at: z.string(), node: z.string(), direction: z.enum(['to-parent', 'to-child']), type: z.string(), text: z.string() })),
})

export type InstallPlan = z.infer<typeof installPlanSchema>
export type PlanModule = InstallPlan['modules'][number]
export type InstallEvent = z.infer<typeof installEventSchema>
export type ResultEvent = Extract<InstallEvent, { type: 'result' }>
export type ModuleResult = z.infer<typeof moduleResultSchema>
export type DoctorReport = z.infer<typeof doctorReportSchema>
export type Status = z.infer<typeof statusSchema>
export type Dispatch = Status['dispatches'][number]
export type HistorySession = z.infer<typeof historySessionSchema>
export type Transcript = z.infer<typeof transcriptSchema>
export type SendResult = z.infer<typeof sendResultSchema>
export type NativeChat = z.infer<typeof nativeChatSchema>
export type ChatApproval = z.infer<typeof chatApprovalSchema>
export type ChatEventLine = z.infer<typeof chatEventLineSchema>
export type ChatEvent = z.infer<typeof chatEventSchema>
export type ChatStateEvent = z.infer<typeof chatStateEventSchema>
export type ChatDeltaEvent = z.infer<typeof chatDeltaEventSchema>
export type ChatProgressEvent = z.infer<typeof chatProgressEventSchema>
export type MessagePart = z.infer<typeof messagePartSchema>
export type TerminalEngine = z.infer<typeof terminalEngineSchema>
export type TerminalSession = z.infer<typeof terminalSessionSchema>
export type SlashCommand = z.infer<typeof slashCommandSchema>
export type QueuedMessage = z.infer<typeof queuedMessageSchema>
export type ChatQueueItem = z.infer<typeof chatQueueItemSchema>
export type CodeServer = z.infer<typeof codeServerSchema>
export type TranscriptEvent = z.infer<typeof transcriptEventSchema>
export type InfoData = z.infer<typeof infoDataSchema>
export type TranscriptImage = z.infer<typeof transcriptImageSchema>
export type CodeEntry = z.infer<typeof codeEntrySchema>
export type CodeFile = z.infer<typeof codeFileSchema>
export type CodeChange = z.infer<typeof codeChangeSchema>
export type CodeDiff = z.infer<typeof codeDiffSchema>
export type BranchChanges = z.infer<typeof branchChangesSchema>
export type ChatRead = z.infer<typeof chatReadSchema>
export type ReplyResult = z.infer<typeof replyResultSchema>
export type OrchestrationGraph = z.infer<typeof orchestrationGraphSchema>
