import { describe, expect, test } from 'bun:test'
import { beginPending, failPending, pendingError, pendingRunning, settlePending, type PendingMap } from '@/lib/pending-model'

const empty: PendingMap = {}

describe('beginPending', () => {
  test('a trigger starts running with what it starts', () => {
    const map = beginPending(empty, 'chat:/work/repo', 'Starting Claude in repo · main')
    expect(map).toEqual({ 'chat:/work/repo': { label: 'Starting Claude in repo · main', status: 'running', error: null } })
  })

  test('one pending per trigger: a second click while it runs is refused', () => {
    const map = beginPending(empty, 'chat:/work/repo', 'Starting Claude')
    if (map === null) throw new Error('first begin refused')
    expect(beginPending(map, 'chat:/work/repo', 'Starting Claude')).toBeNull()
    expect(pendingRunning(map, 'chat:/work/repo')).toBe(true)
  })

  test('another trigger runs alongside', () => {
    const first = beginPending(empty, 'a', 'A')
    if (first === null) throw new Error('first begin refused')
    const both = beginPending(first, 'b', 'B')
    expect(both === null ? [] : Object.keys(both)).toEqual(['a', 'b'])
  })

  test('a failed trigger can run again: that is the retry', () => {
    const running = beginPending(empty, 'a', 'Starting A')
    if (running === null) throw new Error('begin refused')
    const failed = failPending(running, 'a', new Error('no tmux'))
    expect(pendingRunning(failed, 'a')).toBe(false)
    expect(beginPending(failed, 'a', 'Starting A')).toEqual({ a: { label: 'Starting A', status: 'running', error: null } })
  })
})

describe('failPending', () => {
  test('keeps the label and records the error text', () => {
    const running = beginPending(empty, 'a', 'Starting A')
    if (running === null) throw new Error('begin refused')
    expect(failPending(running, 'a', new Error('megabrain chat start exited 1'))).toEqual({ a: { label: 'Starting A', status: 'failed', error: 'megabrain chat start exited 1' } })
  })

  test('an unknown trigger changes nothing', () => {
    expect(failPending(empty, 'nope', new Error('x'))).toBe(empty)
  })
})

describe('settlePending', () => {
  test('a resolved trigger is gone and can start again', () => {
    const running = beginPending(empty, 'a', 'A')
    if (running === null) throw new Error('begin refused')
    const settled = settlePending(running, 'a')
    expect(settled).toEqual({})
    expect(beginPending(settled, 'a', 'A')).not.toBeNull()
  })

  test('an unknown trigger changes nothing', () => {
    expect(settlePending(empty, 'nope')).toBe(empty)
  })
})

describe('pendingError', () => {
  test('an Error gives its message, anything else its text', () => {
    expect(pendingError(new Error('boom'))).toBe('boom')
    expect(pendingError('plain')).toBe('plain')
  })
})
