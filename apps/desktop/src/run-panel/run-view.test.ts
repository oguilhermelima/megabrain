import { describe, expect, test } from 'bun:test'
import { runStatusView } from '@/run-panel/run-view'

describe('runStatusView', () => {
  test('a starting run is pending and says so', () => {
    expect(runStatusView({ kind: 'starting' })).toEqual({ tone: 'pending', label: 'starting', live: true })
  })

  test('a running run is live', () => {
    expect(runStatusView({ kind: 'running' })).toEqual({ tone: 'running', label: 'running', live: true })
  })

  test('exit code 0 is a clean exit', () => {
    expect(runStatusView({ kind: 'exited', code: 0 })).toEqual({ tone: 'ok', label: 'exited ok', live: false })
  })

  test('a non-zero exit names its code', () => {
    expect(runStatusView({ kind: 'exited', code: 127 })).toEqual({ tone: 'failed', label: 'exited with code 127', live: false })
  })

  test('an exit with no code was stopped', () => {
    expect(runStatusView({ kind: 'exited', code: null })).toEqual({ tone: 'stopped', label: 'stopped', live: false })
  })
})
