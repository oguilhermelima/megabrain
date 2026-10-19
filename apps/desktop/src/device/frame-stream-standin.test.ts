import { describe, expect, test } from 'bun:test'
import { retryDelay, standinStreamUrl, standinUdid } from '@/device/frame-stream-standin'
import { simulatorStreamSchema } from '@/device/native-input-standin'

describe('frame stream stand-in', () => {
  test('a simulator polled by the stand-in round-trips through its pseudo URL; a real stream is not one', () => {
    const udid = '6C2B7A7E-0D8E-4C7A-9A0E-1B2C3D4E5F60'
    expect(standinUdid(standinStreamUrl(udid))).toBe(udid)
    expect(standinUdid('http://127.0.0.1:9100/')).toBeNull()
    expect(standinUdid('standin-frame:')).toBeNull()
  })

  test('a failing poll backs off from a second, doubling, at most ten', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000])
    expect(retryDelay(0)).toBe(1_000)
  })

  test('native input stream answers its URL, pixel size and scale', () => {
    const stream = { streamUrl: 'http://127.0.0.1:9100/', width: 1206, height: 2622, scale: 3 }
    expect(simulatorStreamSchema.parse(stream)).toEqual(stream)
    expect(simulatorStreamSchema.safeParse({ ...stream, streamUrl: undefined }).success).toBe(false)
  })
})
