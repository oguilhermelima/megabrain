import { describe, expect, test } from 'bun:test'
import { CliError } from '@/api/adapter'
import type { NativeChat } from '@/api/schema'
import { CHAT_BUSY_NOTICE, OWNER_NOTICE, ownerBar, ownerOf, refusalOf, sendFailure, sendRoute, sendsWhenFree, switchFailure, TERMINAL_BUSY_NOTICE, viewSwitch } from '@/native-chat/terminal-owner'

const chat = (owner: NativeChat['owner'], state: NativeChat['state'] = 'idle', mode: NativeChat['mode'] = 'chat'): NativeChat => ({
  id: 'c', agent: 'claude', model: null, cwd: '/w', title: 't', state, mode, owner,
  agentSessionId: 'sess', createdAt: '2026-10-17T09:00:00Z', lastActivityAt: null,
})

describe('who drives the session', () => {
  test('the record says so when the daemon reports it', () => {
    expect(ownerOf(chat('terminal', 'idle', 'chat'))).toBe('terminal')
    expect(ownerOf(chat('none', 'idle', 'terminal'))).toBe('none')
    expect(ownerOf(chat('chat', 'idle', 'terminal'))).toBe('chat')
  })

  test('an older daemon without owner falls back to the mode', () => {
    expect(ownerOf(chat(undefined, 'idle', 'terminal'))).toBe('terminal')
    expect(ownerOf(chat(undefined, 'idle', 'chat'))).toBe('chat')
  })
})

describe('switching views', () => {
  test('going to the chat only shows it, whoever owns the session', () => {
    for (const owner of ['chat', 'terminal', 'none'] as const) {
      for (const state of ['idle', 'working', 'waiting-approval', 'suspended'] as const) expect(viewSwitch(chat(owner, state, 'terminal'), 'chat')).toBe('show')
    }
  })

  test('going to the terminal the terminal already owns reattaches it without a handoff', () => {
    expect(viewSwitch(chat('terminal', 'working', 'terminal'), 'terminal')).toBe('show')
    expect(viewSwitch(chat('terminal', 'idle', 'terminal'), 'terminal')).toBe('show')
  })

  test('going to the terminal from a chat-owned or free session hands it over', () => {
    expect(viewSwitch(chat('chat', 'idle'), 'terminal')).toBe('switch')
    expect(viewSwitch(chat('none', 'idle', 'terminal'), 'terminal')).toBe('switch')
  })

  test('a switch the chat refuses mid-turn is a plain message and the view stays in chat', () => {
    expect(switchFailure(new CliError('chat-busy: the chat is mid-turn', 1))).toEqual({ notice: CHAT_BUSY_NOTICE })
    expect(CHAT_BUSY_NOTICE).toBe('The chat is still answering; switch to the terminal when it is done')
  })

  test('any other switch failure stays an error with its retry', () => {
    expect(switchFailure(new CliError('chat c is gone', 1))).toEqual({ error: true })
    expect(switchFailure(new Error('session sess is already open in another process'))).toEqual({ error: true })
  })
})

describe('refusals', () => {
  test('are read from the error text', () => {
    expect(refusalOf(new CliError('terminal-busy: the terminal is mid-turn', 1))).toBe('terminal-busy')
    expect(refusalOf(new CliError('chat-busy', 1))).toBe('chat-busy')
    expect(refusalOf('Session sess is already open in another process')).toBe('foreign')
    expect(refusalOf(new Error('network down'))).toBe(null)
    expect(refusalOf(null)).toBe(null)
  })
})

describe('sending while the terminal drives', () => {
  test('takes the session over first, and only then', () => {
    expect(sendRoute(chat('terminal', 'idle', 'terminal'))).toBe('take-over-first')
    expect(sendRoute(chat('terminal', 'idle', 'chat'))).toBe('take-over-first')
    expect(sendRoute(chat('chat', 'idle'))).toBe('send')
    expect(sendRoute(chat('none', 'suspended', 'terminal'))).toBe('send')
  })

  test('a busy terminal keeps the draft in the composer without calling it an error', () => {
    // A held notice keeps the draft and shows no banner: the line above the composer says it is waiting.
    expect(sendFailure(new CliError('terminal-busy: the terminal is mid-turn', 1))).toEqual({ tone: 'held', text: TERMINAL_BUSY_NOTICE })
    expect(TERMINAL_BUSY_NOTICE).toBe('The terminal is still answering · your message is kept')
  })

  test('any other send failure is not held: it rethrows as before', () => {
    expect(sendFailure(new Error('network down'))).toBe(null)
    expect(sendFailure(new CliError('chat-busy', 1))).toBe(null)
  })
})

describe('the notice above the composer', () => {
  test('says nothing while the chat owns the session or nobody does', () => {
    expect(ownerBar(chat('chat', 'working'), 'none')).toBe(null)
    expect(ownerBar(chat('none', 'suspended', 'terminal'), 'none')).toBe(null)
  })

  test('says the terminal drives, with Take over', () => {
    expect(ownerBar(chat('terminal', 'idle', 'terminal'), 'none')).toEqual({ text: OWNER_NOTICE, action: 'take-over' })
    expect(ownerBar(chat('terminal', 'working', 'terminal'), 'none')).toEqual({ text: OWNER_NOTICE, action: 'take-over' })
    expect(OWNER_NOTICE).toBe('The terminal is driving this session')
  })

  test('with a kept draft says it is waiting and offers Send when free, then waits with Cancel', () => {
    expect(ownerBar(chat('terminal', 'working', 'terminal'), 'held')).toEqual({ text: TERMINAL_BUSY_NOTICE, action: 'send-when-free' })
    expect(ownerBar(chat('terminal', 'waiting-approval', 'terminal'), 'held')).toEqual({ text: TERMINAL_BUSY_NOTICE, action: 'send-when-free' })
    expect(ownerBar(chat('terminal', 'working', 'terminal'), 'armed')).toEqual({ text: 'Will send when the terminal is free', action: 'cancel' })
  })

  test('a kept draft once the terminal has finished answering no longer says it is answering', () => {
    expect(ownerBar(chat('terminal', 'idle', 'terminal'), 'held')).toEqual({ text: OWNER_NOTICE, action: 'send-when-free' })
  })

  test('a kept draft whose owner has let go is plain again', () => {
    expect(ownerBar(chat('chat', 'idle'), 'held')).toBe(null)
    expect(ownerBar(chat('none', 'idle', 'terminal'), 'armed')).toBe(null)
  })
})

describe('Send when free', () => {
  test('waits while the terminal is answering', () => {
    expect(sendsWhenFree('armed', chat('terminal', 'working', 'terminal'))).toBe(false)
    expect(sendsWhenFree('armed', chat('terminal', 'waiting-approval', 'terminal'))).toBe(false)
  })

  test('sends once the terminal is idle or has let go', () => {
    expect(sendsWhenFree('armed', chat('terminal', 'idle', 'terminal'))).toBe(true)
    expect(sendsWhenFree('armed', chat('none', 'idle', 'terminal'))).toBe(true)
    expect(sendsWhenFree('armed', chat('chat', 'working'))).toBe(true)
  })

  test('never sends a draft nobody armed', () => {
    expect(sendsWhenFree('held', chat('terminal', 'idle', 'terminal'))).toBe(false)
    expect(sendsWhenFree('none', chat('none', 'idle'))).toBe(false)
  })
})
