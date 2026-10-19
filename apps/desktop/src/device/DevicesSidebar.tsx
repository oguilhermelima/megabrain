import { useRef, useState, type ReactNode } from 'react'
import { Chevron, PlusIcon } from '@/advanced/chrome'
import { PanelIcon } from '@/advanced/WikiShell'
import type { AnchorRect } from '@/advanced/menu-placement'
import { Collapse } from '@/components/Collapse'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { Popover } from '@/components/Popover'
import { Spinner } from '@/components/ui'
import type { WebDevice } from '@/api/schema'
import { elsewhereLabel, groupDevices, groupOf, groupTitles, renameCommit, runtimeLabel, type DeviceChoice, type DeviceGroup, type ElsewhereDevice, type ElsewhereGroup, type OpenDevice, type RenameDraft } from '@/device/device-model'
import { WebDevices } from '@/device/WebDevices'
import { sidePanelBar, sidePanelButton, sidePanelGroup, sidePanelHeaderRow, sidePanelList, sidePanelNote, sidePanelRow, sidePanelSlot, sidePanelTitle, sidePanelTrailing } from '@/lib/side-panel'
import { usePresence } from '@/lib/usePresence'

/** What a device is doing while a lifecycle call is out: the row says so and its actions wait. */
export type DeviceBusy = 'booting' | 'restarting' | 'shutting-down'

const busyLabel: Record<DeviceBusy, string> = { booting: 'Booting…', restarting: 'Restarting…', 'shutting-down': 'Shutting down…' }

/**
 * The Device tab's left panel, laid out as every support panel is (lib/side-panel): the open
 * simulators grouped as phones, tablets and TVs, each row a state dot, the name and the runtime, then
 * the Web group's headless browsers (WebDevices); rename,
 * restart and shut down on hover or focus (a double-click on the name renames too: Enter saves, Escape
 * cancels); and a + that lists the simulators not open yet, to boot one. It lists the devices of this
 * worktree's project, from any of its worktrees; under the list, the rest fold out by project, the ones
 * no project owns last as Not assigned, each one usable here after a confirmation.
 */
export function DevicesSidebar({
  open,
  elsewhere,
  elsewhereCount,
  booting,
  error,
  stale,
  loading,
  selected,
  locked,
  busy,
  choices,
  onSelect,
  onBoot,
  onRestart,
  onShutdown,
  onClaim,
  onRename,
  onHide,
  web,
  controls,
}: {
  /** The devices of this worktree's project. */
  open: OpenDevice[]
  elsewhere: ElsewhereGroup[]
  elsewhereCount: number
  /** Picked from the + and still booting: shown as rows until the booted list has them. */
  booting: DeviceChoice[]
  error: string | null
  /** Which reads failed while their last answer stays on screen. */
  stale: string | null
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
  onClaim: (device: OpenDevice) => Promise<void>
  onRename: (device: OpenDevice, name: string) => void
  onHide: () => void
  /** The selected device's controls, at the bottom. */
  controls: ReactNode
  web: { devices: WebDevice[]; error: string | null; defaultUrl: string; onStart: (url: string, preset: string | null) => Promise<void>; onStop: (device: WebDevice) => Promise<void> }
}) {
  const [picker, setPicker] = useState<AnchorRect | null>(null)
  const menu = usePresence(picker)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useRef(() => setPicker(null)).current
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [othersOpen, setOthersOpen] = useState(false)
  const [draft, setDraft] = useState<RenameDraft>(null)
  const othersText = elsewhereLabel(elsewhereCount)

  const askClaim = ({ device, branch }: ElsewhereDevice, group: ElsewhereGroup) =>
    setConfirm({
      title: `Use ${device.name} here?`,
      body: `${group.assigned ? `It moves from ${group.title}${branch === null ? '' : ` · ${branch}`} to this worktree; a flow running on it there keeps going.` : 'No project owns it yet; it becomes this worktree’s.'}${device.state === 'Asleep' ? ' It boots first.' : ''}`,
      action: 'Use here',
      tone: 'primary',
      run: () => onClaim(device),
    })

  const askShutdown = (device: OpenDevice) =>
    setConfirm({
      title: `Shut down ${device.name}?`,
      body: 'The simulator stops, and so does whatever runs on it, a Maestro flow included.',
      action: 'Shut down',
      run: () => onShutdown(device),
    })

  return (
    <nav aria-label="Devices" className="flex min-h-0 flex-1 flex-col">
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
          <button type="button" onClick={onHide} aria-label="Hide devices" title="Hide devices" className={sidePanelButton}>
            <PanelIcon />
          </button>
        </div>
      </div>
      <div style={{ scrollbarGutter: 'stable' }} className={sidePanelList}>
        {error !== null && <p className={`${sidePanelNote} text-bad select-text`}>{error}</p>}
        {stale !== null && <p className={`${sidePanelNote} text-warn select-text`}>{stale}</p>}
        {loading && open.length === 0 && <p className={sidePanelNote}>Reading simulators…</p>}
        {!loading && error === null && open.length === 0 && booting.length === 0 && web.devices.length === 0 && <p className={sidePanelNote}>No device is open. Boot a simulator with +, or start a browser from Web.</p>}
        {groupDevices([...open, ...booting.filter((device) => !open.some((entry) => entry.udid === device.udid))]).map(({ group, devices }) => {
          const rows = open.filter((device) => devices.includes(device))
          const pending = booting.filter((device) => devices.includes(device))
          return (
            <section key={group} aria-label={groupTitles[group]}>
              <GroupHeader group={group} count={devices.length} />
              <div className="space-y-0.5 pt-0.5 pb-2">
                {rows.map((device) => (
                  <DeviceRow key={device.udid} device={device} selected={device.udid === selected} locked={locked} busy={busy[device.udid] ?? null} onSelect={() => onSelect(device.udid)} onRestart={() => onRestart(device)} onShutdown={() => askShutdown(device)}
                    draft={draft?.udid === device.udid ? draft.text : null}
                    onDraft={(text) => setDraft(text === null ? null : { udid: device.udid, text })}
                    onCommit={() => {
                      const saved = renameCommit(draft, device)
                      setDraft(null)
                      if (saved !== null) onRename(device, saved.name)
                    }}
                  />
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
        <WebDevices devices={web.devices} selected={selected} locked={locked} error={web.error} defaultUrl={web.defaultUrl} icon={groupIcons.web} onSelect={onSelect} onStart={web.onStart} onStop={web.onStop} />
      </div>
      {othersText !== null && (
        <div className="shrink-0 border-t border-white/[0.06] px-2.5 py-1.5">
          <button type="button" onClick={() => setOthersOpen((shown) => !shown)} aria-expanded={othersOpen} className={sidePanelGroup}>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{othersText}</span>
            <Chevron open={othersOpen} />
          </button>
          <Collapse open={othersOpen}>
            <div className="max-h-[40vh] space-y-1 overflow-y-auto pb-1">
              {elsewhere.map((group) => (
                <section key={group.key} aria-label={group.title}>
                  <p title={group.assigned ? group.key : undefined} className="truncate px-2.5 pt-1.5 pb-0.5 text-[11.5px] font-medium text-ink-400">
                    {group.title}
                  </p>
                  {group.devices.map((entry) => (
                    <button key={entry.device.udid} type="button" onClick={() => askClaim(entry, group)} title={`Use ${entry.device.name} in this worktree${entry.branch === null ? '' : `\nOn ${entry.branch}`}${entry.device.state === 'Asleep' ? '\nAsleep' : ''}\n${entry.device.udid}`} className={sidePanelRow(false)}>
                      <span aria-hidden="true" className={sidePanelSlot} />
                      <span aria-hidden="true" className={sidePanelSlot}>
                        {groupIcons[groupOf(entry.device)]}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{entry.device.name}</span>
                      <span className={sidePanelTrailing}>Use here</span>
                    </button>
                  ))}
                </section>
              ))}
            </div>
          </Collapse>
        </div>
      )}
      {controls}
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

function DeviceRow({
  device,
  selected,
  locked,
  busy,
  draft,
  onSelect,
  onRestart,
  onShutdown,
  onDraft,
  onCommit,
}: {
  device: OpenDevice
  selected: boolean
  locked: boolean
  busy: DeviceBusy | null
  /** The name being typed over this device's; null when it is not being renamed. */
  draft: string | null
  onSelect: () => void
  onRestart: () => void
  onShutdown: () => void
  /** A new draft, or null to cancel. */
  onDraft: (text: string | null) => void
  onCommit: () => void
}) {
  const asleep = device.state === 'Asleep'
  // The group says phone or TV, so the row keeps the runtime's version and leaves the name its room.
  const runtime = runtimeLabel(device.runtime)
  const detail = busy !== null ? busyLabel[busy] : asleep ? 'Asleep' : (runtime?.replace(/^(iOS|tvOS)\s+/, '') ?? '')
  const dot = busy !== null ? 'animate-pulse bg-warn' : asleep ? 'bg-ink-500' : 'bg-ok'
  if (draft !== null)
    return (
      <div className={sidePanelRow(selected)}>
        <span aria-hidden="true" className={sidePanelSlot} />
        <span className={sidePanelSlot}>
          <span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
        </span>
        <input
          autoFocus
          value={draft}
          aria-label={`Rename ${device.name}`}
          maxLength={255}
          onChange={(event) => onDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onCommit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onDraft(null)
            }
          }}
          // Leaving the field cancels: only Enter saves.
          onBlur={() => onDraft(null)}
          className="-mx-1 h-6 min-w-0 flex-1 rounded-[6px] bg-white/[0.06] px-1 text-[13px] text-ink-100 outline-none ring-1 ring-accent/60"
        />
      </div>
    )
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => busy === null && onDraft(device.name)}
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
          <RowAction label={`Rename ${device.name}`} onClick={() => onDraft(device.name)}>
            <PencilIcon />
          </RowAction>
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

/** A group's mark, name and count, as the panel's group rows are drawn. */
function GroupHeader({ group, count }: { group: DeviceGroup; count: number }) {
  return (
    <div className={`${sidePanelGroup} pointer-events-none`}>
      <span aria-hidden="true" className={sidePanelSlot}>
        {groupIcons[group]}
      </span>
      <span className="min-w-0 flex-1 truncate">{groupTitles[group]}</span>
      <span className="shrink-0 text-[11px] font-medium tabular-nums">{count}</span>
    </div>
  )
}

function DevicePicker({ choices, onPick }: { choices: DeviceChoice[] | null; onPick: (device: DeviceChoice) => void }) {
  if (choices === null)
    return (
      <p className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] text-ink-400">
        <Spinner /> Reading simulators…
      </p>
    )
  if (choices.length === 0) return <p className="px-2.5 py-1.5 text-[13px] text-ink-400">Every simulator is already open.</p>
  return (
    <>
      {groupDevices(choices).map(({ group, devices }, index) => (
        <div key={group} role="group" aria-label={groupTitles[group]} className={index === 0 ? undefined : 'mt-1.5 border-t border-white/[0.08] pt-1.5'}>
          <p className="px-2.5 pt-1 pb-1 text-[11px] font-medium text-ink-500">{groupTitles[group]}</p>
          {devices.map((device) => (
            <button
              key={device.udid}
              type="button"
              role="menuitem"
              title={device.udid}
              onMouseEnter={(event) => event.currentTarget.focus({ preventScroll: true })}
              onClick={() => onPick(device)}
              className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] text-ink-200 hover:bg-white/[0.08] focus:bg-white/[0.08] focus-visible:outline-none"
            >
              <span className="text-ink-400">{groupIcons[group]}</span>
              <span className="min-w-0 flex-1 truncate">{device.name}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  )
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.5 3 13 5.5 6 12.5H3.5V10z" />
    </svg>
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

function TabletIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.75" y="1.75" width="10.5" height="12.5" rx="1.75" />
      <path d="M7 12h2" strokeLinecap="round" />
    </svg>
  )
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c1.7 1.6 2.5 3.6 2.5 6S9.7 12.4 8 14C6.3 12.4 5.5 10.4 5.5 8S6.3 3.6 8 2z" strokeLinejoin="round" />
    </svg>
  )
}

const groupIcons: Record<DeviceGroup, ReactNode> = { phone: <PhoneIcon />, tablet: <TabletIcon />, tv: <TvIcon />, web: <GlobeIcon /> }
