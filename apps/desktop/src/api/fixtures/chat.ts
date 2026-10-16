import type { ChatEventLine, NativeChat } from '@/api/schema'

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
  {
    cursor: '5',
    event: { id: 'e5', at: at(10), kind: 'approval', text: 'Run pnpm test in apps/web?' },
    approval: { id: 'ap-1', tool: 'Bash', input: 'pnpm --filter web test', reason: 'Runs the web tests', decisions: ['allow', 'allow-session', 'deny'] },
  },
]
