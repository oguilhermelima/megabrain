import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { PlusIcon } from '@/advanced/chrome'
import type { AnchorRect } from '@/advanced/menu-placement'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { Popover } from '@/components/Popover'
import { Spinner } from '@/components/ui'
import { presetGroups, viewportLabel, webDeviceName, webUrl } from '@/device/web-device-model'
import { webDevices, type ViewportPreset, type WebDevice } from '@/device/web-device-standin'
import { sidePanelButton, sidePanelGroup, sidePanelNote, sidePanelRow, sidePanelSlot, sidePanelTrailing } from '@/lib/side-panel'
import { usePresence } from '@/lib/usePresence'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The Devices panel's Web group: the headless browser viewports (`megabrain web device`), each row
 * its page and CSS size, stopped from the row; the group's + opens a small form to start one from a
 * URL (the worktree's dev server, when it has one) and a viewport preset.
 */
export function WebDevices({
  devices,
  selected,
  locked,
  error,
  defaultUrl,
  icon,
  onSelect,
  onStart,
  onStop,
}: {
  devices: WebDevice[]
  selected: string | null
  locked: boolean
  error: string | null
  /** The worktree's dev server, or empty. */
  defaultUrl: string
  icon: ReactNode
  onSelect: (id: string) => void
  onStart: (url: string, preset: string | null) => Promise<void>
  onStop: (device: WebDevice) => Promise<void>
}) {
  const [form, setForm] = useState<AnchorRect | null>(null)
  const shown = usePresence(form)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useRef(() => setForm(null)).current
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)

  return (
    <section aria-label="Web">
      <div className={sidePanelGroup}>
        <span aria-hidden="true" className={sidePanelSlot}>
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate">Web</span>
        {devices.length > 0 && <span className="shrink-0 text-[11px] font-medium tabular-nums">{devices.length}</span>}
        <button
          ref={trigger}
          type="button"
          onClick={(event) => {
            if (form !== null) return setForm(null)
            const rect = event.currentTarget.getBoundingClientRect()
            setForm({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
          }}
          aria-label="Start a web device"
          title="Start a web device"
          aria-haspopup="dialog"
          aria-expanded={form !== null}
          className={`${sidePanelButton} -mr-1.5 size-6`}
        >
          <PlusIcon />
        </button>
      </div>
      <div className="space-y-0.5 pt-0.5 pb-2">
        {error !== null && <p className={`${sidePanelNote} text-bad select-text`}>{error}</p>}
        {devices.map((device) => (
          <div key={device.id} className="group relative">
            <button type="button" onClick={() => onSelect(device.id)} disabled={locked && device.id !== selected} aria-current={device.id === selected || undefined} title={`${webDeviceName(device)}\n${device.url}\n${device.id}`} className={`${sidePanelRow(device.id === selected)} disabled:opacity-50`}>
              <span aria-hidden="true" className={sidePanelSlot} />
              <span className={sidePanelSlot}>
                <span aria-label="running" className="size-2 rounded-full bg-ok" />
              </span>
              <span className="min-w-0 flex-1 truncate">{webDeviceName(device)}</span>
              <span className={`${sidePanelTrailing} group-focus-within:invisible group-hover:invisible`}>{viewportLabel(device)}</span>
            </button>
            <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              <button
                type="button"
                aria-label={`Stop ${webDeviceName(device)}`}
                title={`Stop ${webDeviceName(device)}`}
                onClick={() => setConfirm({ title: `Stop ${webDeviceName(device)}?`, body: 'The headless browser closes, and so does a flow running on it.', action: 'Stop', run: () => onStop(device) })}
                className="grid size-6 place-items-center rounded-full text-ink-400 transition-colors hover:bg-white/[0.1] hover:text-ink-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none"
              >
                <StopIcon />
              </button>
            </span>
          </div>
        ))}
      </div>
      {shown.shown !== null && (
        <Popover role="dialog" focus="input" className="w-[280px] p-3 select-none" anchor={shown.shown} label="Start a web device" leaving={shown.leaving} onClose={close} trigger={trigger.current}>
          <StartForm
            defaultUrl={defaultUrl}
            onStart={async (url, preset) => {
              await onStart(url, preset)
              close()
            }}
          />
        </Popover>
      )}
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
    </section>
  )
}

const field = 'h-8 w-full rounded-[8px] bg-white/[0.06] px-2 text-[13px] text-ink-100 outline-none ring-1 ring-white/[0.08] focus:ring-accent/60'

/** A URL and a viewport preset; Start waits for the device, and a refusal stays in the form. */
function StartForm({ defaultUrl, onStart }: { defaultUrl: string; onStart: (url: string, preset: string | null) => Promise<void> }) {
  const [text, setText] = useState(defaultUrl)
  const [preset, setPreset] = useState('')
  const [presets, setPresets] = useState<ViewportPreset[] | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    webDevices.presets().then(
      (listed) => current && setPresets(listed),
      () => current && setPresets([]),
    )
    return () => {
      current = false
    }
  }, [])
  const url = webUrl(text)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (url === null || starting) return
    setStarting(true)
    setError(null)
    onStart(url, preset === '' ? null : preset).catch((failure: unknown) => {
      setError(message(failure))
      setStarting(false)
    })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5">
      <label className="flex flex-col gap-1 text-[11.5px] font-medium text-ink-400">
        URL
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder="http://localhost:3000" spellCheck={false} autoCapitalize="off" autoCorrect="off" className={field} />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-medium text-ink-400">
        Viewport
        <select value={preset} onChange={(event) => setPreset(event.target.value)} disabled={presets === null} className={field}>
          <option value="">{presets === null ? 'Reading presets…' : 'Default'}</option>
          {presetGroups(presets ?? []).map((group) => (
            <optgroup key={group.category} label={group.category}>
              {group.presets.map((entry) => (
                <option key={entry.slug} value={entry.slug}>
                  {entry.label}
                  {entry.width === null || entry.height === null ? '' : ` · ${entry.width}×${entry.height}`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {error !== null && <p className="text-[12px] leading-4 break-words text-bad-soft select-text">{error}</p>}
      <button type="submit" disabled={url === null || starting} className="flex h-8 items-center justify-center gap-2 rounded-full bg-accent text-[13px] font-medium text-white transition-opacity disabled:opacity-40">
        {starting && <Spinner />}
        {starting ? 'Starting…' : 'Start'}
      </button>
    </form>
  )
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  )
}
