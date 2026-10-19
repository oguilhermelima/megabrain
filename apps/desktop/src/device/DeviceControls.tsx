import { useEffect, useState } from 'react'
import { controlsFor } from '@/device/controls-model'
import type { DeviceGroup } from '@/device/device-model'
import { glyphs } from '@/device/glyphs'
import { webUrl } from '@/device/web-device-model'
import type { ViewportPreset } from '@/device/web-device-standin'

/** A browser's address and viewport, for the Web group's controls. */
export interface AddressControls {
  url: string
  onNavigate: (url: string) => void
  presets: ViewportPreset[] | null
  preset: string | null
  onPreset: (slug: string) => void
}

/**
 * The bottom of the Devices panel: the selected device's controls (controls-model). An Apple TV gets
 * its remote's pad and keys, a phone or tablet its hardware buttons, rotate, a screenshot and the
 * keyboard (focusing the screen so typing goes to it), a browser back, forward, reload, rotate, its
 * URL and its viewport preset. They wait while `disabled` (input not ready, or a run drives the device).
 */
export function DeviceControls({ group, name, disabled, error, onPress, address }: { group: DeviceGroup; name: string; disabled: boolean; error: string | null; onPress: (control: string) => void; address: AddressControls | null }) {
  const controls = controlsFor(group)
  const button = (control: string, label: string, extra = '') => (
    <button key={control} type="button" aria-label={label} title={label} disabled={disabled} onClick={() => onPress(control)} className={`${toolButton} ${extra}`}>
      {glyphs[control] ?? <span className="text-[11px]">{label}</span>}
    </button>
  )
  return (
    <div role="group" aria-label={`${name} controls`} className="flex shrink-0 flex-col gap-2 border-t border-white/[0.06] px-2.5 pt-2.5 pb-3">
      {controls.pad ? (
        <div role="toolbar" aria-label="Remote" className="flex items-center justify-center gap-3">
          <div className="grid grid-cols-3 grid-rows-3 place-items-center">
            <span />
            {button('up', 'Up')}
            <span />
            {button('left', 'Left')}
            {button('select', 'Select', 'border border-white/[0.14]')}
            {button('right', 'Right')}
            <span />
            {button('down', 'Down')}
            <span />
          </div>
          <div className="flex flex-col gap-1">{controls.buttons.map((entry) => button(entry.name, entry.label))}</div>
        </div>
      ) : (
        <div role="toolbar" aria-label={address === null ? 'Device buttons' : 'Browser'} className="flex flex-wrap items-center justify-center gap-0.5">
          {controls.buttons.map((entry) => button(entry.name, entry.label))}
        </div>
      )}
      {controls.address && address !== null && <Address address={address} disabled={disabled} />}
      {error !== null && (
        <p role="status" title={error} className="line-clamp-2 px-1 text-[11.5px] leading-4 break-words text-bad-soft select-text">
          {error}
        </p>
      )}
    </div>
  )
}

/** The URL (Enter goes there; Escape puts the page's back) and the viewport preset. */
function Address({ address, disabled }: { address: AddressControls; disabled: boolean }) {
  const [draft, setDraft] = useState(address.url)
  useEffect(() => setDraft(address.url), [address.url])
  const target = webUrl(draft)
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (target !== null && !disabled) address.onNavigate(target)
        }}
      >
        <input
          value={draft}
          aria-label="Address"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            setDraft(address.url)
            event.currentTarget.blur()
          }}
          className={`${field} ${target === null && draft.trim() !== '' ? 'ring-bad/60' : ''}`}
        />
      </form>
      <select value={address.preset ?? ''} aria-label="Viewport" disabled={disabled || address.presets === null} onChange={(event) => event.target.value !== '' && address.onPreset(event.target.value)} className={field}>
        <option value="" disabled>
          {address.presets === null ? 'Reading presets…' : 'Viewport preset'}
        </option>
        {(address.presets ?? []).map((preset) => (
          <option key={preset.slug} value={preset.slug}>
            {preset.label}
            {preset.width === null || preset.height === null ? '' : ` · ${preset.width}×${preset.height}`}
          </option>
        ))}
      </select>
    </>
  )
}

const field = 'h-7 w-full min-w-0 rounded-[8px] bg-white/[0.06] px-2 text-[12.5px] text-ink-100 outline-none ring-1 ring-white/[0.08] focus:ring-accent/60 disabled:opacity-50'

const toolButton = 'grid h-7 min-w-7 place-items-center rounded-full px-1.5 text-ink-300 transition-colors duration-100 hover:bg-white/[0.1] hover:text-ink-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'
