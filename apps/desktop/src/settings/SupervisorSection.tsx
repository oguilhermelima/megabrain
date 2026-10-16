import { ErrorNote } from '@/components/ui'
import { quiet, SettingRow, SettingsGroup, Switch } from '@/settings/settings-ui'

/** Whether the watcher runs, with its switch, and the way back into setup. */
export function SupervisorSection({ running, pid, error, onToggle, onSetup }: { running: boolean; pid: number | null; error: unknown; onToggle: (running: boolean) => void; onSetup: () => void }) {
  return (
    <>
      <SettingsGroup title="Supervisor">
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${running ? 'bg-ok' : 'bg-bad'}`} aria-hidden="true" />
              Watcher {running ? 'on' : 'off'}
              <span className="font-normal text-ink-400">{running ? `pid ${pid ?? '?'}` : 'stopped'}</span>
            </span>
          }
          description="Watches your dispatches and reports a stuck, finished or dead child back to you."
        >
          <Switch label="Watcher" checked={running} onChange={onToggle} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Setup">
        <SettingRow label="Run setup again" description="Install or update megabrain for your agents.">
          <button type="button" onClick={onSetup} className={`${quiet} border border-white/[0.1] bg-white/[0.04]`}>
            Run setup
          </button>
        </SettingRow>
      </SettingsGroup>
      {error !== null && <ErrorNote error={error} />}
    </>
  )
}
