import { describe, expect, test } from 'bun:test'
import type { NativeChat } from '@/api/schema'
import { chatCapabilities, chatControls } from '@/native-chat/capabilities'

const chat = (fields: Partial<NativeChat> = {}): NativeChat => ({
  id: 'chat-1',
  agent: 'claude',
  model: 'claude-opus-5-5',
  cwd: '/work/repo',
  title: 'A chat',
  state: 'idle',
  mode: 'chat',
  agentSessionId: null,
  createdAt: '2026-10-17T00:00:00Z',
  lastActivityAt: null,
  ...fields,
})

const none = { approvals: false, interrupt: false, liveModelSwitch: false, steer: false, structuredTools: false }

describe('chatCapabilities', () => {
  test('the record says what the agent can do, whatever the agent', () => {
    const reported = { approvals: true, interrupt: true, liveModelSwitch: false, steer: false, structuredTools: true }
    expect(chatCapabilities(chat({ agent: 'grok', capabilities: reported }))).toEqual(reported)
    expect(chatCapabilities(chat({ agent: 'claude', capabilities: none }))).toEqual(none)
  })

  test('a Claude or Codex record from a daemon that does not report them keeps what those chats always did', () => {
    expect(chatCapabilities(chat({ agent: 'claude' }))).toEqual({ approvals: true, interrupt: true, liveModelSwitch: true, steer: false, structuredTools: true })
    expect(chatCapabilities(chat({ agent: 'codex' }))).toEqual({ approvals: true, interrupt: true, liveModelSwitch: true, steer: true, structuredTools: true })
  })

  test('any other agent without them is assumed to do nothing beyond chatting', () => {
    expect(chatCapabilities(chat({ agent: 'agy' }))).toEqual(none)
    expect(chatCapabilities(chat({ agent: 'grok' }))).toEqual(none)
    expect(chatCapabilities(chat({ agent: 'someday' }))).toEqual(none)
  })
})

describe('chatControls', () => {
  const all = { approvals: true, interrupt: true, liveModelSwitch: true, steer: true, structuredTools: true }

  test('every control shows for an agent that can do everything', () => {
    expect(chatControls(chat({ agent: 'grok', state: 'working', capabilities: all }))).toEqual({ approvals: true, stop: true, steer: true, sendNowWhileBusy: true, modelLock: null })
  })

  test('approvals show only when the agent asks for them', () => {
    expect(chatControls(chat({ agent: 'agy', capabilities: { ...all, approvals: false } })).approvals).toBe(false)
  })

  test('without interrupt there is no stop, and a queued message cannot cut a running turn short', () => {
    const controls = chatControls(chat({ agent: 'agy', state: 'working', capabilities: { ...all, interrupt: false } }))
    expect(controls.stop).toBe(false)
    expect(controls.sendNowWhileBusy).toBe(false)
  })

  test('steer is offered only while a turn runs on an agent that takes it', () => {
    expect(chatControls(chat({ agent: 'codex', state: 'working' })).steer).toBe(true)
    expect(chatControls(chat({ agent: 'codex', state: 'idle' })).steer).toBe(false)
    expect(chatControls(chat({ agent: 'claude', state: 'working' })).steer).toBe(false)
    expect(chatControls(chat({ agent: 'grok', state: 'working', capabilities: { ...all, steer: false } })).steer).toBe(false)
  })

  test('without a live model switch the picker is locked, saying why with the agent name', () => {
    expect(chatControls(chat({ agent: 'agy', capabilities: { ...all, liveModelSwitch: false } })).modelLock).toBe('agy cannot switch models in a running chat; start a new chat to use another model')
    expect(chatControls(chat({ agent: 'grok', capabilities: { ...all, liveModelSwitch: false } })).modelLock).toBe('Grok cannot switch models in a running chat; start a new chat to use another model')
    expect(chatControls(chat({ agent: 'claude' })).modelLock).toBeNull()
  })
})
