import type { ChatApproval, ChatEventLine, MessagePart, NativeChat, TranscriptEvent } from '@/api/schema'

const now = Date.now()
const at = (seconds: number) => new Date(now - seconds * 1000).toISOString()

export const mockNativeChat: NativeChat = {
  id: 'chat-0001',
  agent: 'claude',
  model: 'claude-opus-5-5',
  cwd: '/Users/operator/Workspaces/Canto',
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
]

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
}

const chats = new Map<string, MockChat>()
let serial = 0
const nextId = (prefix: string) => `${prefix}-${++serial}`

function mockChat(chatId: string): MockChat {
  let chat = chats.get(chatId)
  if (chat !== undefined) return chat
  const original = chatId === mockNativeChat.id
  chat = { lines: original ? mockChatLines.slice() : [], followers: new Set(), state: original ? 'idle' : 'starting', turnStartedAt: original ? null : new Date().toISOString(), cancel: null }
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

const replyTurn = (text: string): Step[] => [
  { type: 'event', event: { kind: 'user', text } },
  { type: 'state', state: 'working' },
  { type: 'pause', ms: 1500 },
  { type: 'stream', stream: 'thinking', text: `The person wrote "${text.slice(0, 40)}". A short answer is enough; nothing needs to run.` },
  { type: 'event', event: { kind: 'tool-call', text: 'Read', tool: { name: 'Read', input: '{"file_path":"apps/web/src/app/onboarding/page.tsx"}' } } },
  { type: 'pause', ms: 1100 },
  { type: 'event', event: { kind: 'tool-result', text: 'export default function Onboarding() { … }', tool: { name: 'Read', status: 'ok' } } },
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

export function sendMockChat(chatId: string, parts: MessagePart[]) {
  const text = parts.map((part) => (part.type === 'text' ? part.text : '[Image #1]')).join('')
  play(chatId, replyTurn(text))
}

export function interruptMockChat(chatId: string) {
  const chat = mockChat(chatId)
  chat.cancel?.()
  chat.cancel = null
  if (chat.state === 'working' || chat.state === 'waiting-approval') setState(chat, 'idle')
}

export function answerMockApproval(chatId: string, decision: ChatApproval['decisions'][number]) {
  play(chatId, approvedTurn(decision !== 'deny'))
}
