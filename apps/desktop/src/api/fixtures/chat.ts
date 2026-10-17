import type { ChatQueueChange } from '@/api/adapter'
import type { ChatApproval, ChatEventLine, ChatQueueItem, MessagePart, NativeChat, TranscriptEvent } from '@/api/schema'
// Real outputs of Claude's local commands (see command-output.test.ts).
import contextOutput from '@/api/fixtures/captured/command-output/claude-context.txt?raw'
import costOutput from '@/api/fixtures/captured/command-output/claude-cost.txt?raw'
import mcpOutput from '@/api/fixtures/captured/command-output/claude-mcp.txt?raw'
import usageOutput from '@/api/fixtures/captured/command-output/claude-usage.txt?raw'

const now = Date.now()
const at = (seconds: number) => new Date(now - seconds * 1000).toISOString()

export const mockNativeChat: NativeChat = {
  id: 'chat-0001',
  agent: 'claude',
  model: 'claude-opus-5-5',
  cwd: '/Users/operator/Workspaces/canto',
  title: 'Tidy the onboarding steps',
  state: 'working',
  mode: 'chat',
  agentSessionId: '0b1c2d3e-0000-4000-8000-0000000000aa',
  createdAt: at(300),
  lastActivityAt: at(5),
}

export const mockChatLines: ChatEventLine[] = [
  { cursor: '1', event: { id: 'e1', at: at(60), kind: 'user', text: 'Tidy the onboarding steps and run the tests.' } },
  { cursor: '2', event: { id: 'e2', at: at(55), kind: 'assistant', text: 'Looking at the steps first.' } },
  { cursor: '3', event: { id: 'e3', at: at(50), kind: 'tool-call', text: 'Bash', tool: { name: 'Bash', input: 'ls apps/web/src/app/onboarding' } } },
  { cursor: '4', event: { id: 'e4', at: at(49), kind: 'tool-result', text: '_components\n_hooks\n_steps\nlayout.tsx\npage.tsx', tool: { name: 'Bash', status: 'ok' } } },
  ...commandLines(5, ['/usage', usageOutput], ['/cost', costOutput], ['/context', contextOutput], ['/mcp', mcpOutput]),
]

/** A slash command and its output, as chatd stores a local command's: the user line, then the result naming it. */
function commandLines(first: number, ...commands: [string, string][]): ChatEventLine[] {
  return commands.flatMap(([command, text], index) => {
    const cursor = first + index * 2
    return [
      { cursor: String(cursor), event: { id: `e${cursor}`, at: at(48 - index), kind: 'user', text: command } },
      { cursor: String(cursor + 1), event: { id: `e${cursor + 1}`, at: at(48 - index), kind: 'assistant', text, command } },
    ]
  })
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
}

const chats = new Map<string, MockChat>()
let serial = 0
const nextId = (prefix: string) => `${prefix}-${++serial}`

function mockChat(chatId: string): MockChat {
  let chat = chats.get(chatId)
  if (chat !== undefined) return chat
  const original = chatId === mockNativeChat.id
  chat = { lines: original ? mockChatLines.slice() : [], followers: new Set(), state: original ? 'idle' : 'starting', turnStartedAt: original ? null : new Date().toISOString(), cancel: null, queue: [], held: false }
  chats.set(chatId, chat)
  if (original) play(chatId, openingTurn)
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
  const timers = replay.map((line, index) => setTimeout(() => open && onLine(line), 60 * index))
  const start = setTimeout(() => {
    if (!open) return
    onLine({ cursor: cursorOf(chat), queue: chat.queue.slice() })
    onLine({ cursor: cursorOf(chat), ...stateLine(chat) })
    chat.followers.add(onLine)
  }, 60 * replay.length)
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
