import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'accent'

const toneText: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  neutral: 'text-ink-300',
  accent: 'text-accent',
}

const toneDot: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  neutral: 'bg-ink-500',
  accent: 'bg-accent',
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-[12px] font-semibold ${toneText[tone]}`}>
      <span className={`size-1.5 rounded-full ${toneDot[tone]}`} />
      {children}
    </span>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }

const variants = {
  primary: 'bg-accent text-accent-ink hover:bg-[#a3aeff] disabled:bg-ink-700 disabled:text-ink-400',
  secondary: 'border border-white/15 bg-white/[0.07] text-ink-100 hover:bg-white/[0.12] disabled:text-ink-500',
  danger: 'border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20 disabled:opacity-50',
  ghost: 'text-ink-300 hover:bg-white/[0.07] hover:text-ink-100 disabled:text-ink-600',
}

export function Button({ variant = 'secondary', className = '', ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-[14px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed ${variants[variant]} ${className}`}
      {...props}
    />
  )
}

export function Card({ title, aside, children, className = '' }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[24px] border border-white/[0.08] bg-ink-900 ${className}`}>
      {title !== undefined && (
        <header className="flex items-center justify-between px-5 pt-4 pb-1">
          <h3 className="text-[12px] font-semibold tracking-[0.06em] text-ink-400 uppercase">{title}</h3>
          {aside}
        </header>
      )}
      <div className="p-5 pt-3">{children}</div>
    </section>
  )
}

export function Spinner() {
  return <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-ink-600 border-t-accent" aria-label="working" />
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded-lg bg-white/[0.06] px-2 py-0.5 font-mono text-[12.5px] break-all text-ink-100 select-text">{children}</code>
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error)
  return <p className="rounded-2xl border border-bad/30 bg-bad/10 px-4 py-3 text-[13px] text-bad select-text">{message}</p>
}

export function Check({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className={`flex items-start gap-3 rounded-2xl px-3 py-2.5 ${disabled ? 'opacity-50' : 'cursor-pointer hover:bg-ink-850'}`}>
      <input
        type="checkbox"
        className="mt-0.5 size-[18px] accent-[#8e9cff]"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  )
}

export function Segmented<T extends string>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded-full border border-white/10 bg-white/[0.05] p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`h-8 rounded-full px-4 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed ${
            option.value === value ? 'bg-white/[0.14] text-ink-100' : 'text-ink-400 hover:text-ink-200'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function doctorTone(status: string): Tone {
  if (status === 'ok') return 'ok'
  if (status === 'misconfigured') return 'warn'
  return 'neutral'
}
