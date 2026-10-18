import { CliError, type ChatQueueChange } from '@/api/adapter'
import type { ChatApproval, ChatEventLine, ChatQueueItem, InfoData, MessagePart, NativeChat, TranscriptEvent } from '@/api/schema'
// Real outputs of Claude's local commands (see command-output.test.ts).
import contextFullOutput from '@/api/fixtures/captured/command-output/claude-context-full.txt?raw'
import contextOutput from '@/api/fixtures/captured/command-output/claude-context.txt?raw'
import costOutput from '@/api/fixtures/captured/command-output/claude-cost.txt?raw'
import mcpOutput from '@/api/fixtures/captured/command-output/claude-mcp.txt?raw'
import usageOutput from '@/api/fixtures/captured/command-output/claude-usage.txt?raw'

const now = Date.now()
const at = (seconds: number) => new Date(now - seconds * 1000).toISOString()

export const mockNativeChat: NativeChat = {
  id: 'chat-0001',
  agent: 'claude',
  capabilities: { approvals: true, interrupt: true, liveModelSwitch: false, steer: false, structuredTools: true },
  model: 'claude-opus-5-5',
  cwd: '/Users/operator/Workspaces/canto',
  title: 'Tidy the onboarding steps',
  state: 'working',
  mode: 'chat',
  owner: 'chat',
  agentSessionId: '0b1c2d3e-0000-4000-8000-0000000000aa',
  createdAt: at(300),
  lastActivityAt: at(5),
}

// The long answer that closes the step of many tool calls (explainedTurn): most of markdown in one message.
const explainedAnswer = `## How the onboarding steps are wired

The flow is **three steps**, rendered by \`page.tsx\` in the order of its \`steps\` array. Each step is a file under \`_steps\`, and the shared progress bar reads the same array.

### What each step owns

1. **Account** asks for the name and email, and validates both before *Next* unlocks.
2. **Profile** picks the avatar and the language; the language switches the copy at once.
3. **Welcome** was meant to close the flow, but nothing imports it any more.

- The order lives in one place, so renaming files cannot reorder the flow.
- The tests assert the order through the rendered headings, not the file names.
  - That is why the rename is safe.

> Dropping \`welcome.tsx\` changes nothing on screen: the last step already redirects home.

| Step | File | Tested |
| --- | --- | --- |
| Account | \`_steps/account.tsx\` | yes |
| Profile | \`_steps/profile.tsx\` | yes |
| Welcome | \`_steps/welcome.tsx\` | no |

The order comes from this array:

\`\`\`tsx
export const steps = [
  { id: 'account', title: 'Your account', component: AccountStep },
  { id: 'profile', title: 'Your profile', component: ProfileStep },
] as const satisfies readonly OnboardingStep[]
\`\`\`

See the [Next.js routing docs](https://nextjs.org/docs/app/building-your-application/routing) for why \`_steps\` stays out of the routes.`

// Not captured: the real /usage with one meter and one period garbled, to show a section that keeps the generic layout.
const unreadableUsage = usageOutput
  .replace('Current week (Fable): 0% used', 'Current week (Fable): unavailable')
  .replace('  56% of your usage was while 4+ sessions ran in parallel', '  ▒▒ 3 of 7 rows unavailable ▒▒')

export const mockChatLines: ChatEventLine[] = ([
  { id: 'e1', at: at(60), kind: 'user', text: 'Tidy the onboarding steps and run the tests.' },
  { id: 'e2', at: at(55), kind: 'assistant', text: 'Looking at the steps first.' },
  { id: 'e3', at: at(50), kind: 'tool-call', text: 'Bash', tool: { name: 'Bash', input: 'ls apps/web/src/app/onboarding' } },
  { id: 'e4', at: at(49), kind: 'tool-result', text: '_components\n_hooks\n_steps\nlayout.tsx\npage.tsx', tool: { name: 'Bash', status: 'ok' } },
  ...commandEvents(48, ['/usage', usageOutput], ['/cost', costOutput], ['/context', contextOutput], ['/mcp', mcpOutput], ['/usage', unreadableUsage], ['/context', contextFullOutput]),
  ...explainedTurn(40),
] satisfies TranscriptEvent[]).map((event, index) => ({ cursor: String(index + 1), event: { ...event, id: `e${index + 1}` } })).concat([
  { cursor: '30', event: { id: 'e-cut', at: at(2), kind: 'turn-cut', text: '', reason: 'interrupted', partial: true } },
  { cursor: '31', event: { id: 'e-task', at: at(1), kind: 'background-task', text: 'Run the build', backgroundTask: { id: 'task-build', kind: 'shell', label: 'Run the build', state: 'running', startedAt: at(1) } } },
] satisfies ChatEventLine[])

/** A long conversation: 100 turns, for the navigator rail beside the transcript. */
export const mockLongChat: NativeChat = {
  ...mockNativeChat,
  id: 'chat-0002',
  title: 'Plan the release notes',
  state: 'idle',
  agentSessionId: '0b1c2d3e-0000-4000-8000-0000000000ab',
  createdAt: at(7200),
  lastActivityAt: at(60),
}

const longTopics = ['the changelog headings', 'the breaking changes', 'the migration guide', 'the contributor list', 'the upgrade steps']

export const mockLongChatLines: ChatEventLine[] = Array.from({ length: 100 }, (_, turn): ChatEventLine[] => {
  const topic = longTopics[turn % longTopics.length] ?? ''
  const seconds = 7200 - turn * 70
  const answer = turn % 3 === 0 ? `Done with ${topic}.\n\n- Moved the entries under one heading\n- Linked each one to its pull request\n- Left the wording as written` : `Updated ${topic} for turn ${turn + 1}.`
  return [
    { cursor: String(turn * 2 + 1), event: { id: `long-u${turn + 1}`, at: at(seconds), kind: 'user', text: `Turn ${turn + 1}: review ${topic}${turn % 4 === 0 ? ' and keep the tone plain, with no marketing words, so the notes read like a log of what changed' : ''}` } },
    { cursor: String(turn * 2 + 2), event: { id: `long-a${turn + 1}`, at: at(seconds - 30), kind: 'assistant', text: answer } },
  ]
}).flat()

/** A chat whose turns were cut before finishing, with work left running in the background. */
export const mockCutChat: NativeChat = {
  ...mockNativeChat,
  id: 'chat-0003',
  title: 'Ship the billing migration',
  state: 'idle',
  agentSessionId: '0b1c2d3e-0000-4000-8000-0000000000ac',
  createdAt: at(1800),
  lastActivityAt: at(30),
}

/** A Codex chat where megabrain answered /status and /context itself (the command-output event). */
export const mockCodexChat: NativeChat = {
  ...mockNativeChat,
  id: 'chat-0004',
  agent: 'codex',
  model: 'gpt-6-luna',
  title: 'Check the Codex limits',
  state: 'idle',
  agentSessionId: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b',
  createdAt: at(900),
  lastActivityAt: at(40),
}

// Not captured: the CLI lane that appends command-output events (feat/chat-info-commands-all-agents) has
// not landed; these follow its contract. Its own fixtures replace them when it merges.
const inMinutes = (minutes: number) => new Date(now + minutes * 60_000).toISOString()
const codexStatusData: InfoData = {
  model: 'gpt-6-luna',
  effort: 'high',
  approvals: 'never',
  sandbox: 'workspace-write',
  cwd: '/Users/operator/Workspaces/canto',
  session: { id: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b', startedAt: at(900), turns: 12 },
  context: { used: 182_400, window: 400_000, percent: 45.6 },
  limits: [
    { label: '5h limit', usedPercent: 74, resetsAt: inMinutes(131), window: '5h' },
    { label: 'Weekly limit', usedPercent: 38, resetsAt: inMinutes(4 * 24 * 60 + 200), window: 'weekly' },
  ],
  tokens: { input: 1_204_000, output: 38_200, cacheRead: 9_800_000 },
}
const codexStatusText = `Model: gpt-6-luna (reasoning high)
Directory: /Users/operator/Workspaces/canto
Approval: never
Sandbox: workspace-write
Session: 019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b
Context window: 46% used (182.4k / 400k)
5h limit: 74% used
Weekly limit: 38% used`

export const mockCodexChatLines: ChatEventLine[] = ([
  { id: '', at: at(60), kind: 'user', text: '/status' },
  { id: '', at: at(60), kind: 'command-output', command: '/status', agent: 'codex', source: 'megabrain', data: codexStatusData, text: codexStatusText },
  { id: '', at: at(45), kind: 'user', text: '/context' },
  {
    id: '',
    at: at(45),
    kind: 'command-output',
    command: '/context',
    agent: 'codex',
    source: 'megabrain',
    data: { model: 'gpt-6-luna', context: codexStatusData.context },
    text: 'Context window: 46% used (182.4k / 400k)',
  },
] satisfies TranscriptEvent[]).map((event, index) => ({ cursor: String(index + 1), event: { ...event, id: `x${index + 1}` } }))

// Not captured: the Grok (feat/chat-grok-acp) and agy (feat/chat-agy-stream-spike) chat lanes have not
// landed; these follow their contract, capabilities included. Their own fixtures replace them when they merge.

/** What Grok over ACP and agy following its terminal let a chat do. */
export const grokCapabilities = { approvals: true, interrupt: true, liveModelSwitch: true, steer: false, structuredTools: true }
export const agyCapabilities = { approvals: false, interrupt: false, liveModelSwitch: false, steer: false, structuredTools: false }

/** A Grok chat whose tool calls ran and whose next one waits for approval. */
export const mockGrokChat: NativeChat = {
  ...mockNativeChat,
  id: 'chat-0005',
  agent: 'grok',
  model: 'grok-4.7',
  title: 'Fix the flaky upload test',
  state: 'waiting-approval',
  agentSessionId: 'grok-5f6a7b8c',
  createdAt: at(600),
  lastActivityAt: at(20),
  contextTokens: 41_200,
  contextWindow: 256_000,
  capabilities: grokCapabilities,
}

export const mockGrokChatLines: ChatEventLine[] = ([
  { id: '', at: at(120), kind: 'user', text: 'The upload test fails one run in five. Find out why and fix it.' },
  { id: '', at: at(115), kind: 'thinking', text: 'A test that fails sometimes usually waits on time or shares state. I will read it first.' },
  { id: '', at: at(110), kind: 'tool-call', text: 'read_file', tool: { name: 'read_file', input: JSON.stringify({ path: 'apps/web/src/upload/upload.test.ts' }) } },
  { id: '', at: at(109), kind: 'tool-result', text: "test('uploads a file', async () => {\n  start(file)\n  await sleep(200)\n  expect(progress()).toBe(100)\n})", tool: { name: 'read_file', status: 'ok' } },
  { id: '', at: at(100), kind: 'tool-call', text: 'grep', tool: { name: 'grep', input: JSON.stringify({ pattern: 'sleep\\(', path: 'apps/web/src/upload' }) } },
  { id: '', at: at(99), kind: 'tool-result', text: 'apps/web/src/upload/upload.test.ts:14:  await sleep(200)', tool: { name: 'grep', status: 'ok' } },
  { id: '', at: at(90), kind: 'assistant', text: 'The test sleeps **200 ms** and hopes the upload finished. I will wait for the progress event instead, then run the test twenty times to be sure.' },
  { id: '', at: at(85), kind: 'tool-call', text: 'edit_file', tool: { name: 'edit_file', input: JSON.stringify({ path: 'apps/web/src/upload/upload.test.ts', old_string: '  await sleep(200)', new_string: "  await once(uploader, 'done')" }) } },
  { id: '', at: at(84), kind: 'tool-result', text: 'Edited apps/web/src/upload/upload.test.ts', tool: { name: 'edit_file', status: 'ok' } },
  { id: 'grok-approval', at: at(20), kind: 'approval', text: 'Run the upload test twenty times?' },
] satisfies TranscriptEvent[]).map((event, index) => ({
  cursor: String(index + 1),
  event: { ...event, id: event.id === '' ? `g${index + 1}` : event.id },
  ...(event.id === 'grok-approval' ? { approval: { id: 'ap-grok-1', tool: 'run_terminal_cmd', input: 'pnpm --filter web test upload --repeat 20', reason: 'Proves the fix holds across runs', decisions: ['allow', 'allow-session', 'deny'] } satisfies ChatApproval } : {}),
}))

/** An agy chat followed through its terminal: no approvals, no stop, no live model switch. */
export const mockAgyChat: NativeChat = {
  ...mockNativeChat,
  id: 'chat-0006',
  agent: 'agy',
  model: 'gemini-3.8-flash',
  title: 'Polish the seek bar',
  state: 'working',
  agentSessionId: 'agy-9d8e7f60',
  createdAt: at(400),
  lastActivityAt: at(3),
  capabilities: agyCapabilities,
}

export const mockAgyChatLines: ChatEventLine[] = ([
  { id: '', at: at(90), kind: 'user', text: 'Make the seek bar thumb larger on touch screens and keep it still while dragging.' },
  { id: '', at: at(80), kind: 'assistant', text: 'Reading the player styles. The thumb is 12px everywhere; I will raise it to 20px under a coarse pointer and stop the hover transition while a drag runs.' },
  { id: '', at: at(40), kind: 'assistant', text: 'Updated the thumb size and the drag state. Now checking the player in the other themes.' },
] satisfies TranscriptEvent[]).map((event, index) => ({ cursor: String(index + 1), event: { ...event, id: `agy${index + 1}` } }))

const agyQueued: ChatQueueItem = { id: 'q-agy-1', parts: [{ type: 'text', text: 'Also check the bar in the mini player.' }], createdAt: at(10), updatedAt: at(10) }

type Task = NonNullable<TranscriptEvent['backgroundTask']>
const task = (seconds: number, backgroundTask: Task): TranscriptEvent => ({ id: '', at: at(seconds), kind: 'background-task', text: backgroundTask.label, backgroundTask })
const cut = (seconds: number, fields: Pick<TranscriptEvent, 'reason' | 'detail' | 'partial'>): TranscriptEvent => ({ id: '', at: at(seconds), kind: 'turn-cut', text: '', ...fields })
const devServer: Task = { id: 'bg-dev', kind: 'shell', label: 'pnpm --filter web dev', state: 'running', startedAt: at(1500) }
const suite: Task = { id: 'bg-suite', kind: 'shell', label: 'pnpm test --filter billing', state: 'running', startedAt: at(1490) }
const ci: Task = { id: 'bg-ci', kind: 'monitor', label: 'CI checks on #981', state: 'running', startedAt: at(1200) }
const reviewer: Task = { id: 'bg-review', kind: 'agent', label: 'Review the migration diff', state: 'running', startedAt: at(900) }
const tail: Task = { id: 'bg-tail', kind: 'shell', label: 'tail -f logs/worker.log', state: 'running', startedAt: at(880) }

export const mockCutChatLines: ChatEventLine[] = ([
  { id: '', at: at(1510), kind: 'user', text: 'Start the dev server, run the billing tests and watch CI on #981.' },
  { id: '', at: at(1505), kind: 'assistant', text: 'Starting the dev server and the tests in the background, then a monitor on CI.' },
  task(1500, devServer),
  task(1490, suite),
  task(1200, ci),
  { id: '', at: at(1190), kind: 'assistant', text: 'All three are running. While the tests go, I am updating the snapshot files: the invoice totals now round per line, so the first' },
  cut(1185, { reason: 'interrupted', partial: true }),
  task(1100, { ...suite, state: 'completed', endedAt: at(1100), exitCode: 0, summary: '212 pass, 0 fail\nRan 212 tests across 31 files. [41.2s]' }),
  { id: '', at: at(920), kind: 'user', text: 'Leave the snapshots. Run the migration and have an agent review the diff.' },
  task(900, reviewer),
  task(880, tail),
  { id: '', at: at(870), kind: 'assistant', text: 'Running the migration now. The first two steps applied cleanly; the third rewrites' },
  cut(865, { reason: 'process-exited', detail: 'claude exited with code 137', partial: true }),
  task(860, { ...reviewer, state: 'failed', endedAt: at(860), summary: 'The agent stopped: its context window filled before it read the last file.' }),
  task(600, { ...tail, state: 'lost' }),
  { id: '', at: at(320), kind: 'user', text: 'Pick it up from step three.' },
  cut(300, { reason: 'error', detail: 'API returned 529 overloaded', partial: false }),
  { id: '', at: at(60), kind: 'user', text: 'Try again.' },
  { id: '', at: at(50), kind: 'assistant', text: 'Step three applied. Checking the row counts against' },
  cut(45, { reason: 'limit', detail: 'Resets at 18:00', partial: true }),
] satisfies TranscriptEvent[]).map((event, index) => ({ cursor: String(index + 1), event: { ...event, id: `cut-e${index + 1}` } }))

/** A slash command and its output, as chatd stores a local command's: the user line, then the result naming it. */
function commandEvents(seconds: number, ...commands: [string, string][]): TranscriptEvent[] {
  return commands.flatMap(([command, text], index): TranscriptEvent[] => [
    { id: '', at: at(seconds - index), kind: 'user', text: command },
    { id: '', at: at(seconds - index), kind: 'assistant', text, command },
  ])
}

// A step of many tool calls, one failing, then the long answer.
function explainedTurn(seconds: number): TranscriptEvent[] {
  const call = (name: string, input: unknown): TranscriptEvent => ({ id: '', at: at(seconds), kind: 'tool-call', text: name, tool: { name, input: JSON.stringify(input) } })
  const done = (name: string, text: string, status: 'ok' | 'error' = 'ok'): TranscriptEvent => ({ id: '', at: at(seconds), kind: 'tool-result', text, tool: { name, status } })
  return [
    { id: '', at: at(seconds), kind: 'user', text: 'Before you change anything, explain how the steps are wired.' },
    call('Read', { file_path: '/Users/operator/Workspaces/canto/apps/web/src/app/onboarding/page.tsx' }),
    done('Read', "import { steps } from './_steps'\n\nexport default function Onboarding() {\n  return <Stepper steps={steps} />\n}"),
    call('Read', { file_path: '/Users/operator/Workspaces/canto/apps/web/src/app/onboarding/_steps/index.ts' }),
    done('Read', "export const steps = [\n  { id: 'account', title: 'Your account', component: AccountStep },\n  { id: 'profile', title: 'Your profile', component: ProfileStep },\n]"),
    call('Grep', { pattern: 'welcome', path: 'apps/web/src' }),
    done('Grep', 'apps/web/src/app/onboarding/_steps/welcome.tsx'),
    call('WebSearch', { query: 'next.js app router private folders underscore' }),
    done('WebSearch', 'Private folders: prefix a folder with an underscore to opt it out of routing.'),
    call('WebSearch', { query: 'next.js colocation project organization' }),
    done('WebSearch', 'Project organization and file colocation.'),
    call('Bash', { command: 'pnpm --filter web exec tsc --noEmit', description: 'Typecheck the web app' }),
    done('Bash', "apps/web/src/app/onboarding/_steps/welcome.tsx(3,10): error TS2305: Module './shared' has no exported member 'Hero'.", 'error'),
    call('Bash', { command: 'git log --oneline -3 -- apps/web/src/app/onboarding', description: 'Recent onboarding commits' }),
    done('Bash', 'a1b2c3d feat(web): profile step\n9f8e7d6 feat(web): account step\n1234abc feat(web): onboarding shell'),
    { id: '', at: at(seconds), kind: 'assistant', text: explainedAnswer },
  ]
}

// A stand-in for megabrain chatd: each chat keeps its stored lines and its followers, and a turn plays
// state changes, streamed chunks and complete events with the timing of a real agent.

type Step =
  | { type: 'state'; state: NativeChat['state'] }
  | { type: 'stream'; stream: 'assistant' | 'thinking'; text: string }
  | { type: 'event'; event: Omit<TranscriptEvent, 'id' | 'at'>; approval?: ChatApproval }
  | { type: 'pause'; ms: number }

interface MockChat {
  lines: ChatEventLine[]
  followers: Set<(line: ChatEventLine) => void>
  state: NativeChat['state']
  turnStartedAt: string | null
  /** Cancels the turn playing now. */
  cancel: (() => void) | null
  /** Messages sent while a turn ran; the next goes out when the turn ends, unless an interrupt holds them. */
  queue: ChatQueueItem[]
  held: boolean
  /** Which process holds the agent session: the chat, or the agent's TUI that chatd follows. */
  owner: 'chat' | 'terminal' | 'none'
  record: NativeChat
}

const chats = new Map<string, MockChat>()
let serial = 0
const nextId = (prefix: string) => `${prefix}-${++serial}`

function mockChat(chatId: string): MockChat {
  let chat = chats.get(chatId)
  if (chat !== undefined) return chat
  const original = chatId === mockNativeChat.id
  const long = chatId === mockLongChat.id
  const cutTurns = chatId === mockCutChat.id
  const codex = chatId === mockCodexChat.id
  const grok = chatId === mockGrokChat.id
  const agy = chatId === mockAgyChat.id
  const stored = long || cutTurns || codex || grok || agy
  const lines = original ? mockChatLines.slice() : long ? mockLongChatLines.slice() : cutTurns ? mockCutChatLines.slice() : codex ? mockCodexChatLines.slice() : grok ? mockGrokChatLines.slice() : agy ? mockAgyChatLines.slice() : []
  const record: NativeChat = original ? mockNativeChat : long ? mockLongChat : cutTurns ? mockCutChat : codex ? mockCodexChat : grok ? mockGrokChat : agy ? mockAgyChat : { ...mockNativeChat, id: chatId, title: null }
  // A stored chat comes back in the state its record says: idle, Grok waiting on its approval, agy mid-turn.
  const state = original ? 'idle' : stored ? record.state : 'starting'
  const turnStartedAt = state === 'starting' ? new Date().toISOString() : state === 'working' || state === 'waiting-approval' ? at(agy ? 60 : 25) : null
  chat = { lines, followers: new Set(), state, turnStartedAt, cancel: null, queue: agy ? [agyQueued] : [], held: false, owner: 'chat', record }
  chats.set(chatId, chat)
  if (original) play(chatId, openingTurn)
  else if (stored) return chat
  else play(chatId, [{ type: 'pause', ms: 2600 }, { type: 'state', state: 'idle' }])
  return chat
}

const cursorOf = (chat: MockChat) => chat.lines.at(-1)?.cursor ?? '0'

function store(chat: MockChat, line: Omit<ChatEventLine, 'cursor'>) {
  const stored = { cursor: String(chat.lines.length + 1), ...line }
  chat.lines.push(stored)
  for (const follower of chat.followers) follower(stored)
}

function stateLine(chat: MockChat): Omit<ChatEventLine, 'cursor'> {
  return { event: { id: nextId('state'), at: new Date().toISOString(), kind: 'state', text: chat.state, ...(chat.turnStartedAt === null ? {} : { turnStartedAt: chat.turnStartedAt }) } }
}

function setState(chat: MockChat, state: NativeChat['state']) {
  chat.state = state
  if (state === 'working' && chat.turnStartedAt === null) chat.turnStartedAt = new Date().toISOString()
  if (state === 'idle' || state === 'stopped' || state === 'error') chat.turnStartedAt = null
  store(chat, stateLine(chat))
  if (state !== 'idle' || chat.held) return
  const next = chat.queue.shift()
  if (next === undefined) return
  publishQueue(chat)
  setTimeout(() => play(chatIdOf(chat), replyTurn(textOf(next.parts))), 0)
}

const chatIdOf = (chat: MockChat) => [...chats.entries()].find(([, value]) => value === chat)?.[0] ?? ''
const textOf = (parts: MessagePart[]) => parts.map((part) => (part.type === 'text' ? part.text : '[Image #1]')).join('')
const busy = (chat: MockChat) => chat.state === 'working' || chat.state === 'waiting-approval'

function publishQueue(chat: MockChat) {
  for (const follower of chat.followers) follower({ cursor: cursorOf(chat), queue: chat.queue.slice() })
}

/** One to three words at a time, the way a model's chunks arrive. */
function chunks(text: string): string[] {
  const words = text.split(/(?<=\s)/)
  const out: string[] = []
  for (let index = 0; index < words.length; ) {
    const size = 1 + ((index * 7) % 3)
    out.push(words.slice(index, index + size).join(''))
    index += size
  }
  return out
}

function play(chatId: string, steps: Step[]) {
  const chat = mockChat(chatId)
  chat.cancel?.()
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  chat.cancel = () => {
    cancelled = true
    clearTimeout(timer)
  }
  const sleep = (ms: number) => new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))
  void (async () => {
    for (const step of steps) {
      if (cancelled) return
      if (step.type === 'pause') await sleep(step.ms)
      else if (step.type === 'state') setState(chat, step.state)
      else if (step.type === 'event') {
        store(chat, { event: { id: nextId('e'), at: new Date().toISOString(), ...step.event }, ...(step.approval === undefined ? {} : { approval: step.approval }) })
      } else {
        const messageId = nextId('m')
        for (const piece of chunks(step.text)) {
          if (cancelled) return
          for (const follower of chat.followers) follower({ cursor: cursorOf(chat), event: { kind: 'delta', stream: step.stream, messageId, text: piece } })
          await sleep(step.stream === 'thinking' ? 45 : 70)
        }
        if (cancelled) return
        store(chat, { event: { id: nextId('e'), at: new Date().toISOString(), kind: step.stream, text: step.text, messageId } })
      }
    }
    chat.cancel = null
  })()
}

const openingTurn: Step[] = [
  { type: 'state', state: 'working' },
  { type: 'pause', ms: 900 },
  { type: 'stream', stream: 'thinking', text: 'The steps live under _steps, one file each. The order comes from page.tsx, so tidying means renaming the files to match it and dropping the unused welcome step. The tests cover the step order, so they should run before and after.' },
  { type: 'stream', stream: 'assistant', text: 'The steps are split across **five files** and `page.tsx` decides their order. I will:\n\n1. Rename each step after its position\n2. Drop the unused `welcome` step\n3. Run the web tests to confirm the order still holds' },
  { type: 'pause', ms: 400 },
  {
    type: 'event',
    event: { kind: 'approval', text: 'Run pnpm test in apps/web?' },
    approval: { id: 'ap-1', tool: 'Bash', input: 'pnpm --filter web test', reason: 'Runs the web tests', decisions: ['allow', 'allow-session', 'deny'] },
  },
  { type: 'state', state: 'waiting-approval' },
]

const approvedTurn = (allowed: boolean): Step[] =>
  allowed
    ? [
        { type: 'state', state: 'working' },
        { type: 'event', event: { kind: 'tool-call', text: 'Bash', tool: { name: 'Bash', input: '{"command":"pnpm --filter web test"}' } } },
        { type: 'pause', ms: 2400 },
        { type: 'event', event: { kind: 'tool-result', text: ' ✓ onboarding steps (12 tests) 1.8s\n Test Files  1 passed (1)', tool: { name: 'Bash', status: 'ok' } } },
        { type: 'stream', stream: 'thinking', text: 'All twelve pass, so the order held.' },
        { type: 'stream', stream: 'assistant', text: 'The tests pass: **12 of 12**. The steps now read in the order the page shows them.' },
        { type: 'state', state: 'idle' },
      ]
    : [{ type: 'state', state: 'working' }, { type: 'stream', stream: 'assistant', text: 'Understood, I will not run the tests.' }, { type: 'state', state: 'idle' }]

// Two subagents side by side, each with steps of its own, as chatd stores them: the Agent call carries
// `subagent`, the steps `parentId`, and the result that ends one `subagent` with its status.
const agentCall = (id: string, type: string, description: string): Step => ({
  type: 'event',
  event: { kind: 'tool-call', text: 'Agent', tool: { name: 'Agent', input: JSON.stringify({ description, subagent_type: type }) }, subagent: { id, type, description } },
})
const agentStep = (parentId: string, event: Omit<TranscriptEvent, 'id' | 'at'>): Step => ({ type: 'event', event: { ...event, parentId } })
const agentEnd = (id: string, text: string): Step => ({ type: 'event', event: { kind: 'tool-result', text, tool: { name: 'Agent', status: 'ok' }, subagent: { id, status: 'completed' } } })
const subagentSteps: Step[] = [
  agentCall('mock-agent-steps', 'Explore', 'Map the onboarding steps'),
  agentCall('mock-agent-tests', 'general-purpose', 'Find the tests that cover the step order'),
  { type: 'pause', ms: 900 },
  agentStep('mock-agent-steps', { kind: 'tool-call', text: 'Glob', tool: { name: 'Glob', input: '{"pattern":"apps/web/src/app/onboarding/_steps/*"}' } }),
  agentStep('mock-agent-tests', { kind: 'tool-call', text: 'Grep', tool: { name: 'Grep', input: '{"pattern":"step order"}' } }),
  { type: 'pause', ms: 1400 },
  agentStep('mock-agent-steps', { kind: 'tool-result', text: 'account.tsx\nprofile.tsx\nwelcome.tsx', tool: { name: 'Glob', status: 'ok' } }),
  agentStep('mock-agent-tests', { kind: 'tool-result', text: 'apps/web/src/app/onboarding/page.test.tsx', tool: { name: 'Grep', status: 'ok' } }),
  agentStep('mock-agent-steps', { kind: 'assistant', text: 'Three step files; welcome.tsx is not imported anywhere.' }),
  { type: 'pause', ms: 1200 },
  agentEnd('mock-agent-steps', 'Three steps live under `_steps`: account, profile and welcome. **welcome.tsx** is unused.'),
  agentStep('mock-agent-tests', { kind: 'tool-call', text: 'Read', tool: { name: 'Read', input: '{"file_path":"apps/web/src/app/onboarding/page.test.tsx"}' } }),
  { type: 'pause', ms: 1600 },
  agentStep('mock-agent-tests', { kind: 'tool-result', text: "it('renders the steps in order', …)", tool: { name: 'Read', status: 'ok' } }),
  agentEnd('mock-agent-tests', 'page.test.tsx checks the order in one test: *renders the steps in order*.'),
]

const replyTurn = (text: string): Step[] => [
  { type: 'event', event: { kind: 'user', text } },
  { type: 'state', state: 'working' },
  { type: 'pause', ms: 1500 },
  { type: 'stream', stream: 'thinking', text: `The person wrote "${text.slice(0, 40)}". A short answer is enough; nothing needs to run.` },
  { type: 'event', event: { kind: 'tool-call', text: 'Read', tool: { name: 'Read', input: '{"file_path":"apps/web/src/app/onboarding/page.tsx"}' } } },
  { type: 'pause', ms: 1100 },
  { type: 'event', event: { kind: 'tool-result', text: 'export default function Onboarding() { … }', tool: { name: 'Read', status: 'ok' } } },
  ...subagentSteps,
  { type: 'stream', stream: 'assistant', text: 'Got it. The onboarding page still renders the steps in order, so there is nothing else to change here. Tell me if you want the copy reviewed too.' },
  { type: 'state', state: 'idle' },
]

/** megabrain chat events <id> --since <cursor> --follow: the stored lines after the cursor, the state, then live lines. */
export function followMockChat(chatId: string, since: string | null, onLine: (line: ChatEventLine) => void): () => void {
  const chat = mockChat(chatId)
  const after = since === null ? 0 : Number(since)
  const replay = chat.lines.filter((line) => Number(line.cursor) > after)
  let open = true
  // Lines trickle in the way a follow's history does, but a long one does not take minutes.
  const delay = (index: number) => 60 * Math.min(index, 40)
  const timers = replay.map((line, index) => setTimeout(() => open && onLine(line), delay(index)))
  const start = setTimeout(() => {
    if (!open) return
    onLine({ cursor: cursorOf(chat), queue: chat.queue.slice() })
    onLine({ cursor: cursorOf(chat), ...stateLine(chat) })
    chat.followers.add(onLine)
  }, delay(replay.length))
  return () => {
    open = false
    timers.forEach(clearTimeout)
    clearTimeout(start)
    chat.followers.delete(onLine)
  }
}

/** megabrain chat events <id> --since <cursor>: the head line with the queue, then the stored lines after the cursor. */
export function readMockChat(chatId: string, since: string | null): ChatEventLine[] {
  const chat = mockChat(chatId)
  const after = since === null ? 0 : Number(since)
  return [{ cursor: String(after), queue: chat.queue.slice() }, ...chat.lines.filter((line) => Number(line.cursor) > after)]
}

export function sendMockChat(chatId: string, parts: MessagePart[]): { queued: ChatQueueItem | null } {
  const chat = mockChat(chatId)
  if (chat.owner === 'terminal') takeOverMockChat(chatId)
  if (busy(chat)) {
    const now = new Date().toISOString()
    const queued = { id: nextId('q'), parts, createdAt: now, updatedAt: now }
    chat.queue.push(queued)
    publishQueue(chat)
    return { queued }
  }
  chat.held = false
  play(chatId, replyTurn(textOf(parts)))
  return { queued: null }
}

/** megabrain chat fork --at: a new chat holding the source's lines up to the end of the turn of `eventId`. */
export function forkMockChat(chatId: string, eventId: string): NativeChat {
  const source = mockChat(chatId)
  const at = source.lines.findIndex((line) => line.event !== undefined && 'id' in line.event && line.event.id === eventId)
  if (at === -1) throw new CliError(`no event ${eventId} in chat ${chatId}`, 1)
  const next = source.lines.findIndex((line, index) => index > at && line.event?.kind === 'user')
  const lines = source.lines.slice(0, next === -1 ? undefined : next).map((line, index) => ({ ...line, cursor: String(index + 1) }))
  const id = nextId('chat-branch')
  const now = new Date().toISOString()
  const record: NativeChat = { ...source.record, id, title: `${source.record.title ?? 'New chat'} (branch)`, state: 'idle', createdAt: now, lastActivityAt: now }
  chats.set(id, { lines, followers: new Set(), state: 'idle', turnStartedAt: null, cancel: null, queue: [], held: false, owner: 'chat', record })
  return record
}

/** megabrain chat edit-last: a rewind line drops the last message of the person and its answer, then the new parts go in their place. */
export function editLastMockChat(chatId: string, parts: MessagePart[]): NativeChat {
  const chat = mockChat(chatId)
  if (busy(chat)) throw new CliError('chat-busy: the chat is answering; edit when the turn ends', 1)
  // The shown history after earlier rewinds: the last message of the person still in it.
  let shown: string[] = []
  for (const line of chat.lines) {
    const event = line.event
    if (event?.kind === 'rewind') {
      if (event.fromEventId === undefined) continue
      const index = shown.indexOf(event.fromEventId)
      if (index !== -1) shown = shown.slice(0, index)
    } else if (event?.kind === 'user') shown.push(event.id)
  }
  const last = shown.at(-1)
  if (last === undefined) throw new CliError('nothing-to-edit: the chat has no message of yours', 1)
  store(chat, { event: { kind: 'rewind', fromEventId: last, at: new Date().toISOString() } })
  chat.held = false
  play(chatId, replyTurn(textOf(parts)))
  return recordOf(chat)

}

/** megabrain chat queue: the same rules as chatd, an edit moving the message to the end. */
export function changeMockQueue(chatId: string, change: ChatQueueChange): ChatQueueItem[] {
  const chat = mockChat(chatId)
  const take = (itemId: string) => {
    const index = chat.queue.findIndex((item) => item.id === itemId)
    if (index === -1) throw new Error(`message ${itemId} is not in the queue`)
    return chat.queue.splice(index, 1)[0] as ChatQueueItem
  }
  switch (change.action) {
    case 'list':
      return chat.queue.slice()
    case 'clear':
      chat.queue = []
      break
    case 'add':
      sendMockChat(chatId, change.parts)
      break
    case 'edit':
      chat.queue.push({ ...take(change.itemId), parts: change.parts, updatedAt: new Date().toISOString() })
      break
    case 'move': {
      const item = take(change.itemId)
      chat.queue.splice(Math.min(change.to, chat.queue.length), 0, item)
      break
    }
    case 'remove':
      take(change.itemId)
      break
    case 'steer':
      throw new Error('steer needs a running Codex turn')
    case 'send-now': {
      const item = take(change.itemId)
      publishQueue(chat)
      interruptMockChat(chatId)
      chat.held = false
      play(chatId, replyTurn(textOf(item.parts)))
      return chat.queue.slice()
    }
  }
  publishQueue(chat)
  return chat.queue.slice()
}

/** The live-only line that says the chat's artifacts changed. */
export function publishMockArtifacts(chatId: string) {
  for (const follower of mockChat(chatId).followers) follower({ cursor: '', event: { kind: 'artifacts', at: new Date().toISOString() } })
}

export function interruptMockChat(chatId: string) {
  const chat = mockChat(chatId)
  chat.held = true
  chat.cancel?.()
  chat.cancel = null
  if (chat.state === 'working' || chat.state === 'waiting-approval') setState(chat, 'idle')
}

export function answerMockApproval(chatId: string, decision: ChatApproval['decisions'][number]) {
  play(chatId, approvedTurn(decision !== 'deny'))
}

/** The chat as chatd holds it now, with who owns the session. */
function recordOf(chat: MockChat): NativeChat {
  return { ...chat.record, state: chat.state, mode: chat.owner === 'terminal' ? 'terminal' : 'chat', owner: chat.owner }
}

function publishOwner(chat: MockChat, owner: MockChat['owner']) {
  chat.owner = owner
  store(chat, { chat: recordOf(chat) })
}

// A turn the person types in the agent's TUI, which chatd reads from the terminal's session log.
const terminalTurn: Step[] = [{ type: 'pause', ms: 2500 }, ...replyTurn('Run the onboarding tests from here.')]

/** megabrain chat mode: the TUI takes the session once the chat is idle; the chat side only shows. */
export function setMockChatMode(chatId: string, mode: NativeChat['mode']): NativeChat {
  const chat = mockChat(chatId)
  if (mode === 'terminal' && chat.owner === 'chat' && busy(chat)) throw new CliError('chat-busy: the chat is answering; switch when the turn ends', 1)
  if (mode === 'terminal' && chat.owner !== 'terminal') {
    publishOwner(chat, 'terminal')
    play(chatId, terminalTurn)
  }
  return recordOf(chat)
}

/** megabrain chat take-over: refused while the TUI is mid-turn, else the chat resumes the session. */
export function takeOverMockChat(chatId: string): NativeChat {
  const chat = mockChat(chatId)
  if (chat.owner !== 'terminal') return recordOf(chat)
  if (busy(chat)) throw new CliError('terminal-busy: the terminal is answering; try again when its turn ends', 1)
  publishOwner(chat, 'chat')
  return recordOf(chat)
}
