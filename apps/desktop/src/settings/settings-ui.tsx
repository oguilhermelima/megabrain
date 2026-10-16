import type { ReactNode } from 'react'
import type { SectionIcon } from '@/settings/settings-nav'

// The Settings window's parts: grouped cards of rows, each a label with one line of detail and its
// control on the right, drawn with the composer's calm surfaces and quiet controls.

/** Text fields and selects. */
export const field =
  'h-8 min-w-0 rounded-[10px] border border-white/[0.08] bg-white/[0.04] px-2.5 text-[13px] text-ink-100 transition-colors duration-100 placeholder:text-ink-500 hover:border-white/[0.14] focus:border-accent/60 focus:outline-none disabled:opacity-50 motion-reduce:transition-none'

/** A small text button: Edit, Refresh, Revert. */
export const quiet =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold text-ink-300 transition-colors duration-100 hover:bg-white/[0.07] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'

/** An icon-only button. */
export const ghostIcon =
  'grid size-7 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.07] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'

const iconPaths: Record<SectionIcon, ReactNode> = {
  gauge: (
    <>
      <path d="M2.5 11a5.5 5.5 0 1 1 11 0" />
      <path d="m8 11 2.5-3" />
    </>
  ),
  cpu: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
      <path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2" />
    </>
  ),
  link: (
    <>
      <path d="M6.5 9.5 9.5 6.5" />
      <path d="M7 4.5 8.2 3.3a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  sliders: (
    <>
      <path d="M2.5 4.5h4M9.5 4.5h4M2.5 11.5h7M12.5 11.5h1" />
      <circle cx="8" cy="4.5" r="1.5" />
      <circle cx="11" cy="11.5" r="1.5" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="m4.5 6 2 2-2 2M8.5 10.5h3" />
    </>
  ),
}

export function SettingsIcon({ name, className = 'size-4' }: { name: SectionIcon; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {iconPaths[name]}
    </svg>
  )
}

/** A card of related rows, with an optional small heading and something at its right. */
export function SettingsGroup({ title, aside, children }: { title?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      {(title !== undefined || aside !== undefined) && (
        <header className="flex min-h-7 items-center justify-between gap-2 px-1">
          {title !== undefined && <h3 className="text-[12px] font-semibold tracking-[0.04em] text-ink-400 uppercase">{title}</h3>}
          {aside}
        </header>
      )}
      <div className="divide-y divide-white/[0.06] rounded-[16px] border border-white/[0.08] bg-ink-900/80">{children}</div>
    </section>
  )
}

/** One setting: its label and one line of detail at the left, its control at the right. */
export function SettingRow({ label, description, htmlFor, children }: { label: ReactNode; description?: ReactNode; htmlFor?: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        {htmlFor === undefined ? <p className="text-[13.5px] font-medium text-ink-100">{label}</p> : <label htmlFor={htmlFor} className="block text-[13.5px] font-medium text-ink-100">{label}</label>}
        {description !== undefined && <p className="mt-0.5 text-[12.5px] text-ink-400">{description}</p>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

/** An on/off switch on a native checkbox, so keyboard and screen readers treat it as one. */
export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`relative inline-flex h-5 w-9 shrink-0 items-center ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
      <input type="checkbox" role="switch" className="peer sr-only" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="absolute inset-0 rounded-full bg-white/[0.12] transition-colors duration-100 peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent motion-reduce:transition-none" />
      <span className="relative size-4 translate-x-0.5 rounded-full bg-ink-100 shadow-sm transition-transform duration-100 peer-checked:translate-x-[18px] motion-reduce:transition-none" />
    </label>
  )
}

/** The page of one section: its title with icon, its one line, then its groups. */
export function SectionPage({ icon, title, description, children }: { icon: SectionIcon; title: string; description: string; children: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-[640px] gap-6">
      <header className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 place-items-center rounded-[10px] bg-white/[0.06] text-ink-200">
          <SettingsIcon name={icon} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink-100">{title}</h2>
          <p className="mt-0.5 text-[13px] text-ink-400">{description}</p>
        </div>
      </header>
      {children}
    </div>
  )
}
