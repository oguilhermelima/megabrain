import { describe, expect, test } from 'bun:test'
import { createSharedFollow } from '@/lib/shared-follow'

// A fake CLI follow: records each start and stop, and lets the test push values or end it.
function harness() {
  const started: string[] = []
  const stopped: string[] = []
  const live = new Map<string, { push: (value: number) => void; end: (error: string | null) => void }>()
  let visible = true
  const visibility = new Set<() => void>()
  const follow = createSharedFollow<number>({
    start: async (key, onValue, onEnd) => {
      started.push(key)
      live.set(key, { push: onValue, end: (error) => onEnd?.(error) })
      return () => {
        stopped.push(key)
        live.delete(key)
      }
    },
    visible: () => visible,
    onVisibility: (listener) => {
      visibility.add(listener)
      return () => visibility.delete(listener)
    },
  })
  const setVisible = (next: boolean) => {
    visible = next
    for (const listener of visibility) listener()
  }
  return { follow, started, stopped, live, setVisible }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createSharedFollow', () => {
  test('subscribers of one key share one follow, and a late one gets the latest value at once', async () => {
    const { follow, started, live } = harness()
    const first: number[] = []
    const second: number[] = []
    await follow('chat:a', (value) => first.push(value))
    live.get('chat:a')?.push(1)
    await follow('chat:a', (value) => second.push(value))
    live.get('chat:a')?.push(2)
    expect(started).toEqual(['chat:a'])
    expect(first).toEqual([1, 2])
    expect(second).toEqual([1, 2])
  })

  test('the follow stops when the last subscriber leaves, not before', async () => {
    const { follow, stopped } = harness()
    const one = await follow('chat:a', () => {})
    const two = await follow('chat:a', () => {})
    one()
    expect(stopped).toEqual([])
    two()
    expect(stopped).toEqual(['chat:a'])
  })

  test('leaving twice is harmless', async () => {
    const { follow, started, stopped } = harness()
    const one = await follow('chat:a', () => {})
    const two = await follow('chat:a', () => {})
    one()
    one()
    expect(stopped).toEqual([])
    two()
    await follow('chat:a', () => {})
    expect(started).toEqual(['chat:a', 'chat:a'])
  })

  test('different keys follow apart', async () => {
    const { follow, started } = harness()
    await follow('chat:a', () => {})
    await follow('chat:b', () => {})
    expect(started).toEqual(['chat:a', 'chat:b'])
  })

  test('a hidden window pauses the follow and showing it again resumes it', async () => {
    const { follow, started, stopped, setVisible } = harness()
    await follow('chat:a', () => {})
    setVisible(false)
    expect(stopped).toEqual(['chat:a'])
    setVisible(true)
    await tick()
    expect(started).toEqual(['chat:a', 'chat:a'])
  })

  test('nothing starts while the window is hidden', async () => {
    const { follow, started, setVisible } = harness()
    setVisible(false)
    await follow('chat:a', () => {})
    expect(started).toEqual([])
    setVisible(true)
    await tick()
    expect(started).toEqual(['chat:a'])
  })

  test('the end of a follow reaches every subscriber', async () => {
    const { follow, live } = harness()
    const ends: (string | null)[] = []
    await follow('chat:a', () => {}, (error) => ends.push(error))
    await follow('chat:a', () => {}, (error) => ends.push(error))
    live.get('chat:a')?.end('boom')
    expect(ends).toEqual(['boom', 'boom'])
  })

  test('a follow that cannot start rejects for every subscriber waiting on it', async () => {
    const follow = createSharedFollow<number>({ start: () => Promise.reject(new Error('no cli')), visible: () => true, onVisibility: () => () => {} })
    await expect(follow('chat:a', () => {})).rejects.toThrow('no cli')
    // A later subscriber tries again.
    await expect(follow('chat:a', () => {})).rejects.toThrow('no cli')
  })
})
