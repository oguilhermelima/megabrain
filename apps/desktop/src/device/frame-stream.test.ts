import { describe, expect, test } from 'bun:test'
import { createFrameStreamClient, type FrameStreamSource, type FrameUpdate } from './frame-stream'

function fakeSource() {
  let emit: ((update: FrameUpdate) => void) | undefined
  let subscribes = 0
  let unsubscribes = 0
  const source: FrameStreamSource = {
    subscribe(_url, onUpdate) {
      subscribes += 1
      emit = onUpdate
      return () => { unsubscribes += 1 }
    },
  }
  return { source, send: (update: FrameUpdate) => emit?.(update), counts: () => ({ subscribes, unsubscribes }) }
}

describe('frame stream client', () => {
  test('shares one source for subscribers of the same URL and stops when the last leaves', () => {
    const fake = fakeSource()
    const client = createFrameStreamClient(fake.source)
    const first: FrameUpdate[] = []
    const second: FrameUpdate[] = []
    const off1 = client.watch('http://127.0.0.1:8100/', (update) => first.push(update))
    const off2 = client.watch('http://127.0.0.1:8100/', (update) => second.push(update))
    expect(fake.counts().subscribes).toBe(1)
    fake.send({ src: 'device-frame://a/1', width: 640, height: 480, fps: 30, error: null, stalled: false })
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    off1()
    expect(fake.counts().unsubscribes).toBe(0)
    off2()
    expect(fake.counts().unsubscribes).toBe(1)
  })

  test('keeps errors and stalled state observable, then recovers on the next frame', () => {
    const fake = fakeSource()
    const updates: FrameUpdate[] = []
    const off = createFrameStreamClient(fake.source).watch('http://127.0.0.1:8100/', (update) => updates.push(update))
    fake.send({ src: null, width: 0, height: 0, fps: 0, error: 'connection refused', stalled: true })
    fake.send({ src: 'device-frame://a/2', width: 640, height: 480, fps: 24, error: null, stalled: false })
    expect(updates.map(({ error, stalled }) => [error, stalled])).toEqual([[ 'connection refused', true ], [ null, false ]])
    off()
  })

  test('stops a paused or hidden subscription without retaining frames', () => {
    const fake = fakeSource()
    const client = createFrameStreamClient(fake.source)
    const off = client.watch('http://127.0.0.1:8100/', () => {})
    off()
    expect(fake.counts()).toEqual({ subscribes: 1, unsubscribes: 1 })
  })
})
