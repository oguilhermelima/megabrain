import type { Status } from '@/api/schema'

const maxLines = 5

/** What the tray shows: how many dispatches have an open supervisor finding, and the first few. */
export function traySummary(status: Status): { findings: number; lines: string[] } {
  const withFindings = status.dispatches.filter((item) => item.supervision.finding !== null)
  return {
    findings: withFindings.length,
    lines: withFindings.slice(0, maxLines).map((item) => `${item.chatName ?? item.dispatchId.slice(-8)}: ${item.supervision.finding?.cause ?? ''}`),
  }
}
