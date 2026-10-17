import { Children, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { GithubDetail } from '@/api/schema'
import { ContextMenu, type MenuRow, type OpenMenu } from '@/components/ContextMenu'
import { Spinner } from '@/components/ui'
import { heroLayout, type HeroLayout } from '@/github/item-hero-model'
import { ArrowRightIcon, CheckPassIcon, CopyIcon, LinkIcon, MoreIcon, RefreshIcon } from '@/github/icons'
import { Avatar, StatePill, ago, openOnGithub } from '@/github/parts'
import { pageX } from '@/lib/page'

// The hero at the top of a maximised pull request or issue: the state and number above a large
// title, who opened it and when with the branch flow beside it, a row of small stat pills, and the
// action bar: the action the state leads with, then the quiet ways to open, copy and refresh, and a
// more menu. The bar sits beside the title on a wide pane and under it on a narrow one.

export interface HeroButton {
  label: string
  tone: 'accent' | 'merge' | 'quiet'
  icon?: ReactNode
  running?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
}

const buttonBase = 'flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-4 text-[13px] font-semibold transition-colors duration-[var(--motion-enter)] disabled:cursor-not-allowed disabled:opacity-60'
const buttonTone: Record<HeroButton['tone'], string> = {
  accent: 'bg-accent text-accent-ink hover:bg-[#a3aeff]',
  merge: 'bg-[#238636] text-white hover:bg-[#2ea043]',
  quiet: 'border border-white/[0.10] bg-white/[0.05] text-ink-100 hover:bg-white/[0.10]',
}

function ActionButton({ button }: { button: HeroButton }) {
  return (
    <button type="button" onClick={button.onClick} disabled={button.disabled === true || button.running === true} title={button.title} className={`${buttonBase} ${buttonTone[button.tone]}`}>
      {button.running === true ? <Spinner /> : button.icon}
      {button.label}
    </button>
  )
}

function IconAction({ label, onClick, children, disabled }: { label: string; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink-300 transition-colors duration-[var(--motion-enter)] hover:bg-white/[0.08] hover:text-ink-100 disabled:opacity-50">
      {children}
    </button>
  )
}

/** A small stat in the hero's stat row; a button when it leads somewhere (the checks, the merge box). */
export function StatPill({ children, onClick, tone = 'text-ink-300', title }: { children: ReactNode; onClick?: () => void; tone?: string; title?: string }) {
  const className = `inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.03] px-2.5 text-[12px] font-medium tabular-nums ${tone}`
  if (onClick === undefined)
    return (
      <span title={title} className={className}>
        {children}
      </span>
    )
  return (
    <button type="button" onClick={onClick} title={title} className={`${className} transition-colors duration-[var(--motion-enter)] hover:border-white/[0.14] hover:bg-white/[0.07]`}>
      {children}
    </button>
  )
}

/** The head branch flowing into the base as one unit. */
export function BranchFlow({ head, base }: { head: string; base: string }) {
  const chip = 'min-w-0 truncate rounded-full bg-white/[0.06] px-2 font-mono text-[11.5px] leading-[22px] text-ink-200'
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5" title={`${head} into ${base}`}>
      <span className={chip}>{head}</span>
      <span className="shrink-0 text-ink-500">
        <ArrowRightIcon size={12} />
      </span>
      <span className={`${chip} max-w-[40%] shrink-0`}>{base}</span>
    </span>
  )
}

function useHeroLayout() {
  const ref = useRef<HTMLElement>(null)
  const [layout, setLayout] = useState<HeroLayout>('wide')
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => setLayout(heroLayout(element.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, layout }
}

export function ItemHero({
  kind,
  number,
  detail,
  title,
  state,
  draft,
  now,
  loading,
  onRefresh,
  primary,
  secondary,
  more,
  stats,
  compact = false,
  children,
}: {
  kind: 'pr' | 'issue'
  number: number
  detail: GithubDetail | null
  title: string
  state: string
  draft: boolean
  now: number
  loading: boolean
  onRefresh: () => void
  primary: HeroButton | null
  secondary: HeroButton[]
  more: MenuRow[]
  /** The stat row's pills. */
  stats: ReactNode
  /** A shorter hero with no stat row, for the Files tab, where the diff needs the height. */
  compact?: boolean
  /** Below the stats: the reviewers line and the review panel. */
  children?: ReactNode
}) {
  const { ref, layout } = useHeroLayout()
  const [copied, setCopied] = useState(false)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const url = detail?.url ?? null

  const copy = () => {
    if (url === null) return
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      },
      () => {},
    )
  }
  const openMore = (event: React.MouseEvent<HTMLButtonElement>) => {
    const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect()
    setMenu({ anchor: { left, top, right, bottom }, gap: 6, sections: [more.filter((row) => row.danger !== true), more.filter((row) => row.danger === true)].filter((section) => section.length > 0) })
  }

  const bar = (
    <div className={`flex items-center gap-1.5 ${layout === 'wide' ? 'justify-end' : 'flex-wrap'}`}>
      {primary !== null && <ActionButton button={primary} />}
      {secondary.map((button) => (
        <ActionButton key={button.label} button={button} />
      ))}
      {(primary !== null || secondary.length > 0) && <span aria-hidden="true" className="mx-1 h-5 w-px bg-white/[0.08]" />}
      <IconAction label="Open on GitHub" disabled={url === null} onClick={() => url !== null && void openOnGithub(url)}>
        <LinkIcon size={15} />
      </IconAction>
      <IconAction label={copied ? 'Link copied' : 'Copy link'} disabled={url === null} onClick={copy}>
        {copied ? (
          <span className="text-ok">
            <CheckPassIcon size={15} />
          </span>
        ) : (
          <CopyIcon size={15} />
        )}
      </IconAction>
      <IconAction label="Refresh" onClick={onRefresh}>
        <span className={loading && detail !== null ? 'animate-spin' : ''}>
          <RefreshIcon size={15} />
        </span>
      </IconAction>
      {more.length > 0 && (
        <IconAction label="More actions" onClick={openMore}>
          <MoreIcon size={15} />
        </IconAction>
      )}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  )

  const author = detail?.author?.login ?? null
  const byline = detail !== null && (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-ink-400">
      <span className="flex items-center gap-2">
        <Avatar login={author} size={22} />
        <span className="font-semibold text-ink-200">{author ?? 'ghost'}</span>
        <span>opened {ago(detail.createdAt, now)}</span>
      </span>
      {detail.headRefName !== undefined && detail.baseRefName !== undefined && (
        <>
          <span aria-hidden="true" className="text-ink-600">
            ·
          </span>
          <BranchFlow head={detail.headRefName} base={detail.baseRefName} />
        </>
      )}
    </div>
  )

  return (
    <header ref={ref} className={`relative ${pageX} ${compact ? 'pt-5 pb-3' : 'pt-7 pb-5'}`}>
      <div className={layout === 'wide' ? 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-8' : 'space-y-4'}>
        <div className="min-w-0 space-y-3">
          <div className="flex items-center gap-2.5">
            <StatePill kind={kind} state={state} draft={draft} />
            <span className="text-[14px] font-medium text-ink-500 tabular-nums">#{number}</span>
          </div>
          <h1 className={`${compact ? 'text-[20px]' : 'text-[26px]'} leading-[1.25] font-semibold tracking-[-0.02em] text-balance text-ink-100 select-text`}>{title}</h1>
          {byline}
        </div>
        {bar}
      </div>
      {detail !== null && !compact && <div className="mt-5 flex flex-wrap items-center gap-2">{stats}</div>}
      {Children.toArray(children).length > 0 && <div className="mt-4">{children}</div>}
    </header>
  )
}
