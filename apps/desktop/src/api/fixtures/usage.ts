import type { UsageStats } from '@/api/schema'

// `usage stats --json` for the mock: the same report every run, scaled from a fixed daily pattern
// (quiet weekends, a few days off) so the heatmap, the mix and the cards all have something to show.

const DAY = 86_400_000
const shares = { claude: 0.6, codex: 0.37, grok: 0.03 } as const

function dayTotal(index: number, weekday: number): number {
  if (index % 23 === 5 || index % 31 === 9) return 0
  const wave = 0.55 + 0.45 * Math.abs(Math.sin(index * 1.7))
  const weekend = weekday === 0 || weekday === 6 ? 0.25 : 1
  return Math.round(260_000_000 * wave * weekend)
}

export function mockUsageStats(days: number | null, now = new Date()): UsageStats {
  const today = now.toISOString().slice(0, 10)
  const todayTime = Date.parse(`${today}T00:00:00Z`)
  const tracked = 200
  const span = Math.min(days ?? tracked, tracked)
  const daily: UsageStats['daily'] = []
  for (let back = span - 1; back >= 0; back -= 1) {
    const time = todayTime - back * DAY
    const total = dayTotal(Math.floor(time / DAY), new Date(time).getUTCDay())
    if (total === 0) continue
    daily.push({ date: new Date(time).toISOString().slice(0, 10), total, byProvider: { claude: Math.round(total * shares.claude), codex: Math.round(total * shares.codex), grok: Math.round(total * shares.grok) } })
  }
  const sum = daily.reduce((all, day) => all + day.total, 0)
  const split = (total: number) => ({ input: Math.round(total * 0.012), output: Math.round(total * 0.002), cacheRead: Math.round(total * 0.972), cacheWrite: Math.round(total * 0.012), reasoning: Math.round(total * 0.002) })
  const scale = span / 30
  const provider = (name: 'claude' | 'codex' | 'grok', model: string, project: string, cost: number | null) => {
    const total = Math.round(sum * shares[name])
    return { provider: name, tracked: true, ...split(total), total, sessions: Math.round(140 * shares[name] * scale) + 1, turns: Math.round(900 * shares[name] * scale) + 2, cost, unpricedTokens: cost === null ? total : 0, share: sum === 0 ? 0 : total / sum, lastModel: model, lastProject: project, lastActiveAt: now.toISOString() }
  }
  const claudeCost = Math.round(sum * shares.claude * 0.00000034 * 100) / 100
  const best = daily.reduce<UsageStats['bestDay']>((top, day) => (top === null || day.total > top.total ? { date: day.date, total: day.total } : top), null)
  const totals = split(sum)
  return {
    range: { days, from: days === null ? (daily[0]?.date ?? null) : new Date(todayTime - (days - 1) * DAY).toISOString().slice(0, 10), to: today },
    prices: { asOf: '2026-10-06', note: 'An estimate at API list prices; subscriptions are billed differently.' },
    totals: { ...totals, total: sum, sessions: Math.round(140 * scale) + 3, turns: Math.round(900 * scale) + 6, cost: claudeCost, unpricedTokens: Math.round(sum * (shares.codex + shares.grok)) },
    daily,
    activeDays: daily.length,
    bestDay: best,
    cacheShare: sum === 0 ? null : totals.cacheRead / (totals.input + totals.cacheRead + totals.cacheWrite),
    trackingSince: new Date(todayTime - (tracked - 1) * DAY).toISOString().slice(0, 10),
    providers: [
      provider('claude', 'claude-opus-5-5', '/Users/operator/Workspaces/megabrain', claudeCost),
      provider('codex', 'gpt-6-luna', '/Users/operator/Workspaces/canto', null),
      provider('grok', 'grok-4.7-build', '/Users/operator/Workspaces/stack', null),
      { provider: 'agy', tracked: false, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, sessions: 0, turns: 0, cost: null, unpricedTokens: 0, share: 0, lastModel: null, lastProject: null, lastActiveAt: null },
    ],
    models: [
      { provider: 'claude', model: 'claude-opus-5-5', total: Math.round(sum * 0.45), cost: Math.round(claudeCost * 0.8 * 100) / 100 },
      { provider: 'codex', model: 'gpt-6-luna', total: Math.round(sum * 0.37), cost: null },
      { provider: 'claude', model: 'claude-sonnet-5-5', total: Math.round(sum * 0.15), cost: Math.round(claudeCost * 0.2 * 100) / 100 },
      { provider: 'grok', model: 'grok-4.7-build', total: Math.round(sum * 0.03), cost: null },
    ],
    projects: [
      { project: '/Users/operator/Workspaces/megabrain', total: Math.round(sum * 0.5) },
      { project: '/Users/operator/Workspaces/canto', total: Math.round(sum * 0.35) },
      { project: '/Users/operator/Workspaces/stack', total: Math.round(sum * 0.15) },
    ],
    megabrain: { dispatches: Math.round(85 * scale), agentSeconds: Math.round(118_000 * scale), chats: Math.max(1, Math.round(4 * scale)), since: new Date(todayTime - 40 * DAY).toISOString().slice(0, 10) },
  }
}
