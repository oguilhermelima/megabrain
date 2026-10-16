import type { Settings, TerminalEngine } from '@/api/schema'
import { ErrorNote, Segmented } from '@/components/ui'
import { field, SettingRow, SettingsGroup } from '@/settings/settings-ui'

const engineDetail: Record<TerminalEngine, string> = {
  native: 'A terminal owned by the app. It closes when the app quits.',
  tmux: "Sessions on megabrain's own tmux server. They survive the app and can be reopened.",
}

/** Which engine runs the terminal a chat hands over to, and which terminal app opens outside it. */
export function TerminalSection({
  engine,
  terminal,
  error,
  onChange,
  onSetTerminal,
}: {
  engine: TerminalEngine
  terminal: Settings['terminal']
  error: unknown
  onChange: (engine: TerminalEngine) => void
  onSetTerminal: (name: string | null) => void
}) {
  return (
    <>
      <SettingsGroup title="Embedded terminal">
        <SettingRow label="Engine" description={engineDetail[engine]}>
          <div role="group" aria-label="Terminal engine">
            <Segmented
              value={engine}
              options={[
                { value: 'native', label: 'Native' },
                { value: 'tmux', label: 'tmux' },
              ]}
              onChange={onChange}
            />
          </div>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Outside the app">
        <SettingRow label="Default terminal" description="The terminal app megabrain opens a viewer in." htmlFor="default-terminal">
          <select id="default-terminal" value={terminal.default ?? ''} onChange={(event) => onSetTerminal(event.target.value === '' ? null : event.target.value)} className={`${field} max-w-56`}>
            <option value="">Automatic ({terminal.detected ?? 'none detected'})</option>
            {terminal.available.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingsGroup>
      {error !== null && <ErrorNote error={error} />}
    </>
  )
}
