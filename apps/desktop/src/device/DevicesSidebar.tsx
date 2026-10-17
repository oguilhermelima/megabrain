import { useRef, useState, type ReactNode } from 'react'
import { PlusIcon } from '@/advanced/chrome'
import type { AnchorRect } from '@/advanced/menu-placement'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { Popover } from '@/components/Popover'
import { Spinner } from '@/components/ui'
import { runtimeLabel, type DeviceChoice, type OpenDevice } from '@/device/device-model'
import { sidePanelBar, sidePanelButton, sidePanelGroup, sidePanelHeaderRow, sidePanelList, sidePanelNote, sidePanelRow, sidePanelSlot, sidePanelTitle, sidePanelTrailing } from '@/lib/side-panel'
import { usePresence } from '@/lib/usePresence'

/** What a device is doing while a lifecycle call is out: the row says so and its actions wait. */
export type DeviceBusy = 'booting' | 'restarting' | 'shutting-down'

const busyLabel: Record<DeviceBusy, string> = { booting: 'Booting…', restarting: 'Restarting…', 'shutting-down': 'Shutting down…' }

/**
 * The Device tab's left panel, laid out as every support panel is (lib/side-panel): the open
 * simulators grouped as phones and TVs, each row a state dot, the name and the runtime; restart and
 * shut down on hover or focus; and a + that lists the simulators not open yet, to boot one.
 */
export function DevicesSidebar({
  open,
  booting,
  error,
  loading,
  selected,
  locked,
  busy,
  choices,
  onSelect,
  onBoot,
  onRestart,
  onShutdown,
}: {
  open: OpenDevice[]
  /** Picked from the + and still booting: shown as rows until the booted list has them. */
  booting: DeviceChoice[]
  error: string | null
  loading: boolean
  selected: string | null
  /** A run is going: the selection stays on its device. */
  locked: boolean
  busy: Record<string, DeviceBusy>
  choices: DeviceChoice[] | null
  onSelect: (udid: string) => void
  onBoot: (device: DeviceChoice) => void
  onRestart: (device: OpenDevice) => void
  onShutdown: (device: OpenDevice) => Promise<void>
}) {
  const [picker, setPicker] = useState<AnchorRect | null>(null)
  const menu = usePresence(picker)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useRef(() => setPicker(null)).current
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)

  const askShutdown = (device: OpenDevice) =>
    setConfirm({
      title: `Shut down ${device.name}?`,
      body: 'The simulator stops, and so does whatever runs on it, a Maestro flow included.',
      action: 'Shut down',
      run: () => onShutdown(device),
    })

  return (
    <nav aria-label="Devices" data-sidebar-surface="" className="flex min-h-0 flex-1 flex-col">
      <div className={sidePanelBar}>
        <div className={sidePanelHeaderRow}>
          <h2 className={sidePanelTitle}>Devices</h2>
          <button
            ref={trigger}
            type="button"
            onClick={(event) => {
              if (picker !== null) return setPicker(null)
              const rect = event.currentTarget.getBoundingClientRect()
              setPicker({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
            }}
            aria-label="Open a device"
            title="Boot a simulator"
            aria-haspopup="menu"
            aria-expanded={picker !== null}
            className={sidePanelButton}
          >
            <PlusIcon />
          </button>
        </div>
      </div>
      <div style={{ scrollbarGutter: 'stable' }} className={sidePanelList}>
        {error !== null && <p className={`${sidePanelNote} text-bad select-text`}>{error}</p>}
        {loading && open.length === 0 && <p className={sidePanelNote}>Reading simulators…</p>}
        {!loading && error === null && open.length === 0 && booting.length === 0 && <p className={sidePanelNote}>No device is open. Boot an iPhone or Apple TV simulator with +.</p>}
        {(['phone', 'tv'] as const).map((kind) => {
          const rows = open.filter((device) => device.kind === kind)
          const pending = booting.filter((device) => device.kind === kind && !open.some((entry) => entry.udid === device.udid))
          if (rows.length === 0 && pending.length === 0) return null
          return (
            <section key={kind} aria-label={kindTitle[kind]}>
              <div className={`${sidePanelGroup} pointer-events-none`}>
                <span aria-hidden="true" className={sidePanelSlot}>
                  {kind === 'tv' ? <TvIcon /> : <PhoneIcon />}
                </span>
                <span className="min-w-0 flex-1 truncate">{kindTitle[kind]}</span>
                <span className="shrink-0 text-[11px] font-medium tabular-nums">{rows.length + pending.length}</span>
              </div>
              <div className="space-y-0.5 pt-0.5 pb-2">
                {rows.map((device) => (
                  <DeviceRow key={device.udid} device={device} selected={device.udid === selected} locked={locked} busy={busy[device.udid] ?? null} onSelect={() => onSelect(device.udid)} onRestart={() => onRestart(device)} onShutdown={() => askShutdown(device)} />
                ))}
                {pending.map((device) => (
                  <div key={device.udid} aria-busy="true" className={`${sidePanelRow(false)} pointer-events-none`}>
                    <span aria-hidden="true" className={sidePanelSlot} />
                    <span className={sidePanelSlot}>
                      <span aria-label="booting" className="size-2 animate-pulse rounded-full bg-warn" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{device.name}</span>
                    <span className={sidePanelTrailing}>{busyLabel.booting}</span>
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>
      {menu.shown !== null && (
        <Popover role="menu" focus='[role="menuitem"]' className="max-h-[min(420px,calc(100vh-16px))] w-[240px] overflow-y-auto p-1.5 select-none" anchor={menu.shown} label="Open a device" leaving={menu.leaving} onClose={close} trigger={trigger.current}>
          <DevicePicker
            choices={choices}
            onPick={(device) => {
              close()
              onBoot(device)
            }}
          />
        </Popover>
      )}
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
    </nav>
  )
}

function DeviceRow({ device, selected, locked, busy, onSelect, onRestart, onShutdown }: { device: OpenDevice; selected: boolean; locked: boolean; busy: DeviceBusy | null; onSelect: () => void; onRestart: () => void; onShutdown: () => void }) {
  const asleep = device.state === 'Asleep'
  // The group says phone or TV, so the row keeps the runtime's version and leaves the name its room.
  const runtime = runtimeLabel(device.runtime)
  const detail = busy !== null ? busyLabel[busy] : asleep ? 'Asleep' : (runtime?.replace(/^(iOS|tvOS)\s+/, '') ?? '')
  const dot = busy !== null ? 'animate-pulse bg-warn' : asleep ? 'bg-ink-500' : 'bg-ok'
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        disabled={locked && !selected}
        aria-current={selected || undefined}
        title={`${device.name}${runtime === null ? '' : ` · ${runtime}`}${asleep ? '\nAsleep: boots when you run a flow' : ''}\n${device.udid}`}
        className={`${sidePanelRow(selected)} disabled:opacity-50`}
      >
        <span aria-hidden="true" className={sidePanelSlot} />
        <span className={sidePanelSlot}>
          <span aria-label={busy ?? (asleep ? 'asleep' : 'booted')} className={`size-2 rounded-full ${dot}`} />
        </span>
        <span className="min-w-0 flex-1 truncate">{device.name}</span>
        {/* The runtime gives way to the actions while the row is hovered or focused. */}
        <span className={`${sidePanelTrailing} ${busy === null ? 'group-focus-within:invisible group-hover:invisible' : ''}`}>{detail}</span>
      </button>
      {busy === null && (
        <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <RowAction label={`Restart ${device.name}`} onClick={onRestart}>
            <RestartIcon />
          </RowAction>
          <RowAction label={`Shut down ${device.name}`} onClick={onShutdown} disabled={asleep}>
            <PowerIcon />
          </RowAction>
        </span>
      )}
    </div>
  )
}

function RowAction({ label, onClick, disabled = false, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="grid size-6 place-items-center rounded-full text-ink-400 transition-colors hover:bg-white/[0.1] hover:text-ink-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none disabled:hidden">
      {children}
    </button>
  )
}

const kindTitle = { phone: 'Phones', tv: 'TVs' } as const

function DevicePicker({ choices, onPick }: { choices: DeviceChoice[] | null; onPick: (device: DeviceChoice) => void }) {
  if (choices === null)
    return (
      <p className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-ink-400">
        <Spinner /> Reading simulators…
      </p>
    )
  if (choices.length === 0) return <p className="px-2.5 py-1.5 text-[13px] text-ink-400">Every simulator is already open.</p>
  const kinds = (['phone', 'tv'] as const).filter((kind) => choices.some((device) => device.kind === kind))
  return (
    <>
      {kinds.map((kind, index) => (
        <div key={kind} role="group" aria-label={kindTitle[kind]} className={index === 0 ? undefined : 'mt-1.5 border-t border-white/[0.08] pt-1.5'}>
          <p className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-ink-500">{kindTitle[kind]}</p>
          {choices
            .filter((device) => device.kind === kind)
            .map((device) => (
              <button
                key={device.udid}
                type="button"
                role="menuitem"
                title={device.udid}
                onMouseEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
                onClick={() => onPick(device)}
                className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] text-ink-200 hover:bg-white/[0.08] focus:bg-white/[0.08] focus-visible:outline-none"
              >
                <span className="text-ink-400">{kind === 'tv' ? <TvIcon /> : <PhoneIcon />}</span>
                <span className="min-w-0 flex-1 truncate">{device.name}</span>
              </button>
            ))}
        </div>
      ))}
    </>
  )
}

function RestartIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.8v2.6h-2.6" />
    </svg>
  )
}

export function PowerIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M8 2.5v5M5 4.2a5 5 0 1 0 6 0" />
    </svg>
  )
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="1.75" width="7" height="12.5" rx="1.75" />
      <path d="M7 12h2" strokeLinecap="round" />
    </svg>
  )
}

function TvIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="1.75" y="3" width="12.5" height="8.5" rx="1.5" />
      <path d="M5.5 14h5" strokeLinecap="round" />
    </svg>
  )
}
