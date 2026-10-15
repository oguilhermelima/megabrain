import { Card, ErrorNote } from '@/components/ui'

export function SupervisorSection({ running, pid, error, onToggle }: { running: boolean; pid: number | null; error: unknown; onToggle: (running: boolean) => void }) {
  return (
    <Card title="Supervisor">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[14px] font-semibold text-ink-100">{running ? `Running (pid ${pid ?? '?'})` : 'Stopped'}</p>
          <p className="mt-1 text-[12.5px] text-ink-400">Watches your dispatches and reports a stuck or dead child back to you.</p>
        </div>
        <label className="relative inline-flex h-7 w-12 cursor-pointer items-center rounded-full bg-white/[0.08]">
          <input type="checkbox" className="peer sr-only" checked={running} onChange={(event) => onToggle(event.target.checked)} />
          <span className="absolute inset-0 rounded-full bg-accent opacity-0 transition-opacity peer-checked:opacity-100" />
          <span className="relative z-10 size-5 translate-x-1 rounded-full bg-ink-100 transition-transform peer-checked:translate-x-6" />
        </label>
      </div>
      {error !== null && <div className="mt-3"><ErrorNote error={error} /></div>}
    </Card>
  )
}
