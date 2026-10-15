import { Button, Card, ErrorNote } from '@/components/ui'

/** Whether the watcher runs, with its switch, and the way back into setup; both used to sit at the bottom of the sidebar. */
export function SupervisorSection({ running, pid, error, onToggle, onSetup }: { running: boolean; pid: number | null; error: unknown; onToggle: (running: boolean) => void; onSetup: () => void }) {
  return (
    <div className="space-y-4">
      <Card title="Supervisor">
        <div className="flex items-center justify-between">
          <div>
            <p className="flex items-center gap-2 text-[14px] font-semibold text-ink-100">
              <span className={`size-2 rounded-full ${running ? 'bg-ok' : 'bg-bad'}`} aria-hidden="true" />
              Watcher {running ? 'on' : 'off'}
              <span className="font-normal text-ink-400">{running ? `pid ${pid ?? '?'}` : 'stopped'}</span>
            </p>
            <p className="mt-1 text-[12.5px] text-ink-400">Watches your dispatches and reports a stuck, finished or dead child back to you.</p>
          </div>
          <label className="relative inline-flex h-7 w-12 cursor-pointer items-center rounded-full bg-white/[0.08]">
            <input type="checkbox" className="peer sr-only" aria-label="Watcher" checked={running} onChange={(event) => onToggle(event.target.checked)} />
            <span className="absolute inset-0 rounded-full bg-accent opacity-0 transition-opacity peer-checked:opacity-100" />
            <span className="relative z-10 size-5 translate-x-1 rounded-full bg-ink-100 transition-transform peer-checked:translate-x-6" />
          </label>
        </div>
        {error !== null && <div className="mt-3"><ErrorNote error={error} /></div>}
      </Card>
      <Card title="Setup">
        <div className="flex items-center justify-between gap-4">
          <p className="text-[12.5px] text-ink-400">Walk through setup again to install or update megabrain for your agents.</p>
          <Button onClick={onSetup}>Run setup</Button>
        </div>
      </Card>
    </div>
  )
}
