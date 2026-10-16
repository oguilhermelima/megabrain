import { describe, expect, test } from 'bun:test'
import { onPanelsSettled, panelsMoving, startPanelMotion } from '@/lib/panel-motion'

describe('panel motion', () => {
  test('nothing moves at rest', () => {
    expect(panelsMoving()).toBe(false)
  })

  test('a panel moves until it ends, and settling is announced once', () => {
    let calls = 0
    const stop = onPanelsSettled(() => (calls += 1))
    const end = startPanelMotion()
    expect(panelsMoving()).toBe(true)
    end()
    expect(panelsMoving()).toBe(false)
    expect(calls).toBe(1)
    stop()
  })

  test('two panels at once settle only when both have stopped', () => {
    let calls = 0
    const stop = onPanelsSettled(() => (calls += 1))
    const sidebar = startPanelMotion()
    const runs = startPanelMotion()
    sidebar()
    expect(panelsMoving()).toBe(true)
    expect(calls).toBe(0)
    runs()
    expect(panelsMoving()).toBe(false)
    expect(calls).toBe(1)
    stop()
  })

  test('ending twice counts once', () => {
    let calls = 0
    const stop = onPanelsSettled(() => (calls += 1))
    const end = startPanelMotion()
    const other = startPanelMotion()
    end()
    end()
    expect(panelsMoving()).toBe(true)
    other()
    expect(panelsMoving()).toBe(false)
    expect(calls).toBe(1)
    stop()
  })

  test('a listener that stopped listening is not called', () => {
    let calls = 0
    const stop = onPanelsSettled(() => (calls += 1))
    stop()
    startPanelMotion()()
    expect(calls).toBe(0)
  })
})
