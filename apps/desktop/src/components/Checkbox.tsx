import { useEffect, useRef, type ReactNode } from 'react'
import { checkboxMark, toggled } from '@/components/checkbox-model'

/**
 * The app's checkbox: a native input kept for keyboard, form and screen-reader behaviour, drawn as a
 * 16px rounded box filled with the accent and an SVG mark. The whole label is the click target.
 */
export function Checkbox({
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
  children,
  className = '',
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  /** The label; without one, pass an aria-label through a wrapping element. */
  children?: ReactNode
  className?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  const mark = checkboxMark(checked, indeterminate)
  // indeterminate is a DOM property only; React does not set it from an attribute.
  useEffect(() => {
    if (input.current !== null) input.current.indeterminate = indeterminate
  }, [indeterminate])
  const filled = mark !== 'unchecked'
  return (
    <label className={`group flex min-w-0 items-start gap-2.5 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`}>
      <span className="relative mt-[2px] grid size-4 shrink-0 place-items-center">
        <input
          ref={input}
          type="checkbox"
          className="peer absolute inset-0 m-0 size-full cursor-[inherit] appearance-none rounded-[4px] opacity-0"
          checked={checked}
          disabled={disabled}
          onChange={() => onChange(toggled(mark))}
        />
        <span
          aria-hidden="true"
          className={`pointer-events-none grid size-4 place-items-center rounded-[4px] border transition-colors duration-100 motion-reduce:transition-none peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${
            filled ? 'border-accent bg-accent text-accent-ink' : `border-ink-500 bg-ink-850 text-transparent ${disabled ? '' : 'group-hover:border-ink-400'}`
          }`}
        >
          <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            {mark === 'indeterminate' ? <path d="M4 8h8" /> : <path d="m3.5 8.5 3 3 6-7" />}
          </svg>
        </span>
      </span>
      {children !== undefined && <span className="min-w-0 flex-1">{children}</span>}
    </label>
  )
}
