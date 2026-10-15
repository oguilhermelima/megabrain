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
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850 px-2 py-0.5 text-[11px] font-medium ${toneText[tone]}`}>
      <span className={`size-1.5 rounded-full ${toneDot[tone]}`} />
      {children}
    </span>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' }

const variants = {
  primary: 'bg-accent text-ink-950 hover:bg-[#93adff] disabled:bg-ink-700 disabled:text-ink-400',
  secondary: 'border border-ink-600 bg-ink-800 text-ink-100 hover:bg-ink-700 disabled:text-ink-500',
  danger: 'border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20 disabled:opacity-50',
  ghost: 'text-ink-300 hover:bg-ink-800 hover:text-ink-100 disabled:text-ink-600',
}

export function Button({ variant = 'secondary', className = '', ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={`inline-flex h-8 items-center justify-center gap-2 rounded-md px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${className}`}
      {...props}
    />
  )
}

export function Card({ title, aside, children, className = '' }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-ink-700 bg-ink-900 ${className}`}>
      {title !== undefined && (
        <header className="flex items-center justify-between border-b border-ink-700 px-4 py-2.5">
          <h3 className="text-[12px] font-semibold tracking-wide text-ink-300 uppercase">{title}</h3>
          {aside}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Spinner() {
  return <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-ink-600 border-t-accent" aria-label="working" />
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded bg-ink-850 px-1.5 py-0.5 font-mono text-[12px] break-all text-ink-100 select-text">{children}</code>
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error)
  return <p className="rounded-md border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] text-bad select-text">{message}</p>
}

export function Check({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className={`flex items-start gap-3 rounded-md px-2 py-2 ${disabled ? 'opacity-50' : 'cursor-pointer hover:bg-ink-850'}`}>
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[#7c9cff]"
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
    <div className="inline-flex rounded-md border border-ink-700 bg-ink-850 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`h-7 rounded px-3 text-[12px] font-medium transition-colors disabled:cursor-not-allowed ${
            option.value === value ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200'
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
