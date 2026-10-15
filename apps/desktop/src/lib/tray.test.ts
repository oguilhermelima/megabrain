import { describe, expect, test } from 'bun:test'
import { mockStatus } from '@/api/fixtures/mock'
import type { Status } from '@/api/schema'
import { traySummary } from '@/lib/tray'

function withDispatches(dispatches: Status['dispatches']): Status {
  return { ...mockStatus, dispatches }
}

describe('traySummary', () => {
  test('counts open findings and lists one line per finding', () => {
    const findings = mockStatus.dispatches.filter((item) => item.supervision.finding !== null)
    const summary = traySummary(mockStatus)
    expect(summary.findings).toBe(findings.length)
    expect(summary.lines).toHaveLength(findings.length)
  })
  test('names the dispatch and the cause in each line', () => {
    const [first] = mockStatus.dispatches.filter((item) => item.supervision.finding !== null)
    if (first === undefined) throw new Error('the mock needs a finding')
    expect(traySummary(mockStatus).lines[0]).toContain(first.supervision.finding?.cause ?? '')
    expect(traySummary(mockStatus).lines[0]).toContain(first.chatName ?? first.dispatchId.slice(-8))
  })
  test('shows at most five lines', () => {
    const [first] = mockStatus.dispatches.filter((item) => item.supervision.finding !== null)
    if (first === undefined) throw new Error('the mock needs a finding')
    const many = Array.from({ length: 8 }, (_, index) => ({ ...first, dispatchId: `${first.dispatchId}-${index}` }))
    const summary = traySummary(withDispatches(many))
    expect(summary.findings).toBe(8)
    expect(summary.lines).toHaveLength(5)
  })
  test('is empty with no findings', () => {
    expect(traySummary(withDispatches([]))).toEqual({ findings: 0, lines: [] })
  })
})
