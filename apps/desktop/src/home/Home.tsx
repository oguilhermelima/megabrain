import type { Dispatch, Status } from '@/api/schema'
import { Badge, Button, Card, ErrorNote, Mono, Spinner } from '@/components/ui'
import { useStatus } from '@/home/useStatus'

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`

function pressureTone(pressure: string) {
  return pressure === 'normal' ? 'ok' : pressure === 'elevated' ? 'warn' : 'bad'
}

function name(item: Dispatch) {
  return item.chatName ?? item.branch ?? item.dispatchId.slice(-8)
}

// The first screen after setup. The full panel (dispatch detail, queue, processes, worktrees, agents,
// modules, settings) is its own piece of work; this shows that megabrain is alive and what needs you.
export function Home({ onSetup }: { onSetup: () => void }) {
  const { status, error } = useStatus()
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-ink-800 px-8 py-4">
        <div className="flex items-center gap-2.5">
          <img src="/icon.png" alt="" className="size-7 rounded-md" />
          <span className="text-[14px] font-semibold text-ink-100">megabrain</span>
        </div>
        <Button variant="ghost" onClick={onSetup}>
          Run setup
        </Button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {error !== null && <ErrorNote error={error} />}
        {status === null ? error === null && <Spinner /> : <Overview status={status} />}
      </main>
    </div>
  )
}

function Overview({ status }: { status: Status }) {
  const findings = status.dispatches.filter((item) => item.supervision.finding !== null)
  const states = new Map<string, number>()
  for (const item of status.dispatches) states.set(item.state, (states.get(item.state) ?? 0) + 1)
  const { machine } = status
  return (
    <div className="grid max-w-5xl grid-cols-3 gap-4">
      <Card title="Watcher">
        <Badge tone={status.supervisor.watcher.running ? 'ok' : 'bad'}>{status.supervisor.watcher.running ? 'running' : 'stopped'}</Badge>
        <p className="mt-2 text-[12px] text-ink-500">
          {status.supervisor.watcher.running ? `pid ${status.supervisor.watcher.pid ?? 'unknown'}` : 'Start it with megabrain supervise.'}
        </p>
      </Card>
      <Card title="Machine">
        {machine === null ? (
          <span className="text-ink-500">not available</span>
        ) : (
          <div className="space-y-1 text-[12px]">
            <div className="flex justify-between">
              <span className="text-ink-400">Pressure</span>
              <Badge tone={pressureTone(machine.pressure)}>{machine.pressure}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-400">Memory free</span>
              <span className="text-ink-100">
                {gib(machine.availableMemoryBytes)} of {gib(machine.totalMemoryBytes)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-400">Swap</span>
              <span className="text-ink-100">{gib(machine.swapUsedBytes)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-ink-400">Load</span>
              <span className="text-ink-100">
                {machine.loadAverage1.toFixed(1)} / {machine.cpuCount} cores
              </span>
            </div>
          </div>
        )}
      </Card>
      <Card title="Dispatches">
        <div className="text-[24px] font-semibold text-ink-100">{status.dispatches.length}</div>
        <p className="mt-1 text-[12px] text-ink-500">
          {[...states].map(([state, count]) => `${count} ${state}`).join(' · ') || 'none open'}
          {status.queue.length > 0 && ` · queue: ${status.queue.length}`}
        </p>
      </Card>
      <Card title="Needs you" className="col-span-3" aside={<Badge tone={findings.length === 0 ? 'ok' : 'warn'}>{findings.length}</Badge>}>
        {findings.length === 0 ? (
          <p className="text-ink-500">No supervisor findings.</p>
        ) : (
          <ul className="divide-y divide-ink-800">
            {findings.map((item) => (
              <li key={item.dispatchId} className="py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-ink-100">{name(item)}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-[11px] text-ink-500">{item.agent}</span>
                    <Badge tone="warn">{item.supervision.finding?.cause}</Badge>
                  </span>
                </div>
                {item.supervision.finding?.recommendation !== undefined && (
                  <p className="mt-1.5 text-[12px] text-ink-300">
                    <Mono>{item.supervision.finding.recommendation}</Mono>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
