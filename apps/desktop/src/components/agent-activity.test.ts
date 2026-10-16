import { describe, expect, test } from 'bun:test'
import { activityOf, agentMarkLook } from '@/components/agent-activity'

describe('activityOf', () => {
  test('a chat starting or running a turn is working', () => {
    expect(activityOf('working')).toBe('working')
    expect(activityOf('starting')).toBe('working')
  })

  test('a chat or session waiting for the person is waiting', () => {
    expect(activityOf('waiting-approval')).toBe('waiting')
    expect(activityOf('waiting')).toBe('waiting')
  })

  test('everything else is idle', () => {
    for (const state of ['idle', 'ended', 'stopped', 'error', 'unknown'] as const) expect(activityOf(state)).toBe('idle')
  })
})

describe('agentMarkLook', () => {
  test('idle is the plain grey mark, still', () => {
    for (const agent of ['claude', 'codex', 'agy', 'grok']) expect(agentMarkLook(agent, 'idle')).toEqual({ color: null, motion: null })
  })

  test('Claude working turns its brand orange and spins', () => {
    expect(agentMarkLook('claude', 'working')).toEqual({ color: '#D97757', motion: 'spin' })
  })

  test('Codex and agy working take a tint and spin', () => {
    for (const agent of ['codex', 'agy']) {
      const look = agentMarkLook(agent, 'working')
      expect(look.motion).toBe('spin')
      expect(look.color).not.toBeNull()
    }
  })

  test('Grok working shows a coloured wave instead of spinning', () => {
    const look = agentMarkLook('grok', 'working')
    expect(look.motion).toBe('wave')
    expect(look.color).not.toBeNull()
  })

  test('waiting pulses amber whatever the agent', () => {
    for (const agent of ['claude', 'codex', 'agy', 'grok']) expect(agentMarkLook(agent, 'waiting')).toEqual({ color: 'amber', motion: 'pulse' })
  })

  test('an agent without a brand still shows it works', () => {
    expect(agentMarkLook('someone', 'working').motion).toBe('spin')
  })
})
