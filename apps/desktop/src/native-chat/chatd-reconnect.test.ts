import { describe, expect, test } from 'bun:test'
import { CliError } from '@/api/adapter'
import type { ChatDaemonStatus } from '@/api/schema'
import { chatdNotice, isIncompatible, reconnectDecision, reconnectStep, watchesChatd } from '@/native-chat/chatd-reconnect'

const APP = '0.3.0'
const protocol = { version: 3, min: 2, max: 3 }
const running = (daemon: Partial<Extract<ChatDaemonStatus, { running: true }>>): ChatDaemonStatus => ({
  running: true,
  protocol,
  daemonVersion: APP,
  superseded: false,
  liveChats: 0,
  compatible: true,
  ...daemon,
})

describe('reconnecting to chatd on start', () => {
  test('none running: nothing to keep, the next chat call starts a current one', () => {
    const decision = reconnectDecision({ running: false }, APP)
    expect(decision).toEqual({ kind: 'none' })
    expect(reconnectStep(decision, 'wait')).toBe('nothing')
    expect(chatdNotice(decision, 'waiting')).toBeNull()
    expect(watchesChatd(decision)).toBe(false)
  })

  test('same version: the app keeps using it and never retires, drains or restarts it', () => {
    const decision = reconnectDecision(running({ liveChats: 2 }), APP)
    expect(decision).toEqual({ kind: 'current' })
    expect(reconnectStep(decision, 'wait')).toBe('nothing')
    expect(reconnectStep(decision, 'restart-now')).toBe('nothing')
    expect(chatdNotice(decision, 'waiting')).toBeNull()
    expect(watchesChatd(decision)).toBe(false)
  })

  test('older and compatible: the app keeps using it and retires it so it exits when idle', () => {
    const decision = reconnectDecision(running({ daemonVersion: '0.2.9', liveChats: 2 }), APP)
    expect(decision).toEqual({ kind: 'older', liveChats: 2, superseded: false })
    expect(reconnectStep(decision, 'wait')).toBe('retire')
    expect(watchesChatd(decision)).toBe(true)
  })

  test('older and already retired: it is left to finish, never retired twice or drained', () => {
    const decision = reconnectDecision(running({ daemonVersion: '0.2.9', liveChats: 1, superseded: true }), APP)
    expect(reconnectStep(decision, 'wait')).toBe('nothing')
    expect(reconnectStep(decision, 'restart-now')).toBe('nothing')
    expect(watchesChatd(decision)).toBe(true)
  })

  test('incompatible with live chats: it waits for them by default and drains only on Restart now', () => {
    const decision = reconnectDecision(running({ daemonVersion: '0.1.0', compatible: false, liveChats: 2 }), APP)
    expect(decision).toEqual({ kind: 'incompatible', liveChats: 2 })
    expect(reconnectStep(decision, 'wait')).toBe('wait')
    expect(reconnectStep(decision, 'restart-now')).toBe('drain')
    expect(watchesChatd(decision)).toBe(true)
  })

  test('incompatible once every chat is idle: it drains, and the next call starts the new daemon', () => {
    const decision = reconnectDecision(running({ daemonVersion: '0.1.0', compatible: false, liveChats: 0 }), APP)
    expect(reconnectStep(decision, 'wait')).toBe('drain')
  })

  test('a daemon that does not report the new fields is treated as current', () => {
    expect(reconnectDecision({ running: true }, APP)).toEqual({ kind: 'current' })
  })
})

describe('a refusal from a chat call', () => {
  test('chatd-incompatible is the same signal as an incompatible status', () => {
    expect(isIncompatible(new CliError('chatd speaks protocol 1', 1, 'chatd-incompatible'))).toBe(true)
    expect(isIncompatible(new CliError('chat not found', 1, 'chat-not-found'))).toBe(false)
    expect(isIncompatible(new Error('chatd-incompatible'))).toBe(false)
  })
})

describe('the notice', () => {
  test('an older daemon still serving shows a muted, dismissible line counting the chats it finishes', () => {
    expect(chatdNotice(reconnectDecision(running({ daemonVersion: '0.2.9', liveChats: 2 }), APP), 'waiting')).toEqual({
      tone: 'muted',
      text: 'Update applied · 2 chats finish on the previous version',
      dismissible: true,
      actions: [],
    })
    expect(chatdNotice(reconnectDecision(running({ daemonVersion: '0.2.9', liveChats: 1 }), APP), 'waiting')?.text).toBe('Update applied · 1 chat finishes on the previous version')
  })

  test('an older daemon with nothing left to finish shows nothing', () => {
    expect(chatdNotice(reconnectDecision(running({ daemonVersion: '0.2.9', liveChats: 0 }), APP), 'waiting')).toBeNull()
  })

  test('incompatible with live chats asks to pause, Wait first and the default', () => {
    expect(chatdNotice(reconnectDecision(running({ compatible: false, daemonVersion: '0.1.0', liveChats: 2 }), APP), 'waiting')).toEqual({
      tone: 'attention',
      text: 'This update needs the chats to pause: 2 are working',
      dismissible: false,
      actions: [
        { id: 'wait', label: 'Wait', default: true },
        { id: 'restart-now', label: 'Restart now', default: false },
      ],
    })
    expect(chatdNotice(reconnectDecision(running({ compatible: false, daemonVersion: '0.1.0', liveChats: 1 }), APP), 'waiting')?.text).toBe('This update needs the chats to pause: 1 is working')
  })

  test('while the old daemon drains the notice says the chats are restarting and offers nothing', () => {
    expect(chatdNotice(reconnectDecision(running({ compatible: false, daemonVersion: '0.1.0', liveChats: 1 }), APP), 'restarting')).toEqual({
      tone: 'attention',
      text: 'Restarting the chats on the new version: running turns finish first',
      dismissible: false,
      actions: [],
    })
  })
})
