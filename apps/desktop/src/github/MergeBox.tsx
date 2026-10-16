import type { Ref } from 'react'
import type { GithubMergeMethod } from '@/api/schema'
import { Spinner } from '@/components/ui'
import { CheckFailIcon, CheckPassIcon, CheckPendingIcon, CheckSkippedIcon } from '@/github/icons'
import type { MergeBox as MergeBoxState, PrimaryAction, SecondaryAction, Tone } from '@/github/merge-box-model'

// The merge box at the end of a pull request's conversation, as on GitHub: where the merge stands
// (checks, reviews, conflicts), the method and the merge itself, then the quieter ways out. Every
// action is the parent's; anything that merges or closes goes through its confirm dialog.

export const mergeMethods: { value: GithubMergeMethod; label: string }[] = [
  { value: 'squash', label: 'Squash and merge' },
  { value: 'merge', label: 'Create a merge commit' },
  { value: 'rebase', label: 'Rebase and merge' },
]

const toneText: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', muted: 'text-ink-400' }
const toneEdge: Record<Tone, string> = { ok: 'border-ok/30', warn: 'border-warn/30', bad: 'border-bad/35', muted: 'border-white/[0.08]' }

function ToneGlyph({ tone }: { tone: Tone }) {
  const Icon = tone === 'ok' ? CheckPassIcon : tone === 'bad' ? CheckFailIcon : tone === 'warn' ? CheckPendingIcon : CheckSkippedIcon
  return (
    <span className={`shrink-0 ${toneText[tone]}`}>
      <Icon size={15} />
    </span>
  )
}

const primaryLabel: Record<PrimaryAction, string> = {
  'merge': 'Merge',
  'auto-merge': 'Enable auto-merge',
  'disable-auto-merge': 'Disable auto-merge',
  'ready-for-review': 'Ready for review',
  'reopen': 'Reopen pull request',
}
export const secondaryLabel: Record<SecondaryAction, string> = {
  'rerun-failed': 'Re-run failed checks',
  'convert-to-draft': 'Convert to draft',
  'close': 'Close pull request',
}

const button = 'flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60'
const primaryTone: Record<PrimaryAction, string> = {
  'merge': 'bg-[#238636] text-white hover:bg-[#2ea043]',
  'auto-merge': 'bg-[#238636] text-white hover:bg-[#2ea043]',
  'disable-auto-merge': 'border border-white/[0.12] bg-white/[0.06] text-ink-100 hover:bg-white/[0.12]',
  'ready-for-review': 'bg-accent text-accent-ink hover:bg-[#a3aeff]',
  'reopen': 'border border-white/[0.12] bg-white/[0.06] text-ink-100 hover:bg-white/[0.12]',
}
const quiet = 'flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60'
const secondaryTone: Record<SecondaryAction, string> = {
  'rerun-failed': 'text-ink-300 hover:bg-white/[0.07] hover:text-ink-100',
  'convert-to-draft': 'text-ink-300 hover:bg-white/[0.07] hover:text-ink-100',
  'close': 'text-ink-400 hover:bg-bad/10 hover:text-bad',
}

export type MergeBoxRunning = PrimaryAction | SecondaryAction | null

export function MergeBox({ box, method, onMethod, running, onPrimary, onSecondary, ref }: {
  box: MergeBoxState
  method: GithubMergeMethod
  onMethod: (method: GithubMergeMethod) => void
  /** The action whose write is running; every button waits while one runs. */
  running: MergeBoxRunning
  onPrimary: (action: PrimaryAction) => void
  onSecondary: (action: SecondaryAction) => void
  ref?: Ref<HTMLElement>
}) {
  const busy = running !== null
  return (
    <section ref={ref} aria-label="Merge" className={`scroll-mt-4 rounded-[20px] border bg-ink-900 ${toneEdge[box.tone]}`}>
      <header className="flex items-start gap-3 px-5 pt-4 pb-3">
        <ToneGlyph tone={box.tone} />
        <div className="min-w-0">
          <h3 className="text-[14.5px] leading-5 font-semibold text-ink-100">{box.headline}</h3>
          {box.detail !== '' && <p className="mt-0.5 text-[12.5px] text-ink-400">{box.detail}</p>}
        </div>
      </header>
      {box.rows.length > 0 && (
        <ul className="border-t border-white/[0.06] px-5 py-2">
          {box.rows.map((row) => (
            <li key={row.kind} className="flex items-center gap-3 py-1.5 text-[13px] text-ink-200">
              <ToneGlyph tone={row.tone} />
              {row.text}
            </li>
          ))}
        </ul>
      )}
      {(box.primary !== null || box.secondary.length > 0) && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] px-5 py-3">
          {box.primary !== null && (
            <div className="flex items-center gap-2">
              <button type="button" disabled={busy || box.primaryDisabled} title={box.primaryDisabled ? box.detail : undefined} onClick={() => box.primary !== null && onPrimary(box.primary)} className={`${button} ${primaryTone[box.primary]}`}>
                {running === box.primary ? <Spinner /> : null}
                {primaryLabel[box.primary]}
              </button>
              {box.showMethod && (
                <label className="relative flex h-8 items-center rounded-full border border-white/[0.12] bg-white/[0.06] text-[12.5px] font-semibold text-ink-100">
                  <span className="sr-only">Merge method</span>
                  <select value={method} disabled={busy} onChange={(event) => onMethod(event.target.value as GithubMergeMethod)} style={{ colorScheme: 'dark' }} className="h-full cursor-pointer appearance-none rounded-full bg-transparent px-3 outline-none">
                    {mergeMethods.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <span className="ml-auto" />
          {box.secondary.map((action) => (
            <button key={action} type="button" disabled={busy} onClick={() => onSecondary(action)} className={`${quiet} ${secondaryTone[action]}`}>
              {running === action ? <Spinner /> : null}
              {secondaryLabel[action]}
            </button>
          ))}
        </footer>
      )}
    </section>
  )
}
