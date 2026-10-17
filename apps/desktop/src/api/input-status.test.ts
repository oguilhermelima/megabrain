import { describe, expect, test } from 'bun:test'
import { inputSessionSchema, inputStatusSchema } from '@/api/schema'
import { inputView } from '@/device/input-session'

// What `native input start|status UDID --json` print on the CLI lane that makes start asynchronous
// (fix/native-input-start): optional fields are left out rather than null, and ready may carry an empty startedAt.
const UDID = '8DC5F714-063B-448C-A245-07697677BF67'

describe('the input status the CLI prints parses', () => {
  test('no session: only its phase', () => {
    expect(inputStatusSchema.parse({ udid: UDID, state: 'none', phase: 'idle' })).toEqual({ udid: UDID, state: 'none', phase: 'idle', startedAt: null, error: null })
  })

  test('starting: a phase and when it started', () => {
    expect(inputStatusSchema.parse({ udid: UDID, state: 'starting', phase: 'validating simulator', startedAt: '2026-10-17T21:00:00.000Z' })).toEqual({ udid: UDID, state: 'starting', phase: 'validating simulator', startedAt: '2026-10-17T21:00:00.000Z', error: null })
  })

  test('ready: an empty startedAt is no time, and the session fields pass through', () => {
    const ready = inputStatusSchema.parse({ udid: UDID, state: 'ready', phase: 'ready', startedAt: '', session: 'abc', port: 4723 })
    expect(ready.startedAt).toBeNull()
    expect(ready.state).toBe('ready')
  })

  test('failed: the decisive line', () => {
    expect(inputStatusSchema.parse({ udid: UDID, state: 'failed', phase: 'launching', startedAt: '2026-10-17T21:00:00.000Z', error: 'xcodebuild failed with code 65' }).error).toBe('xcodebuild failed with code 65')
  })

  test('start answers with its state alone while it starts, or with the session once ready', () => {
    expect(inputSessionSchema.parse({ udid: UDID, state: 'starting' }).udid).toBe(UDID)
    expect(inputSessionSchema.parse({ udid: UDID, state: 'ready', session: 'abc', port: 4723 }).udid).toBe(UDID)
    expect(inputSessionSchema.parse({ udid: UDID, session: 'abc', port: 4723 }).udid).toBe(UDID)
  })
})

describe('the CLI’s phase reads as a sentence', () => {
  test('a lowercase phase starts with a capital', () => {
    const view = inputView({ udid: UDID, state: 'starting', phase: 'validating simulator', startedAt: null, error: null }, 0)
    expect(view).toEqual({ kind: 'starting', phase: 'Validating simulator', elapsedMs: 0 })
  })
})
