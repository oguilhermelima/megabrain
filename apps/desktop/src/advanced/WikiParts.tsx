import type { ReactNode } from 'react'
import type { Project } from '@/api/schema'
import { column } from '@/advanced/knowledge-parts'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { byDisplayName, displayName } from '@/advanced/appearance-model'
import { projectColor, projectInitials } from '@/advanced/picture-model'
import { ContextMenu, useContextMenu } from '@/components/ContextMenu'

// What the Knowledge and Artifacts pages draw alike inside their shell (WikiShell): the bar's project
// switcher, a reading section's heading, a list box, and the reading column with nothing to read.

/** A project's picture when megabrain lists it, else its initials on its colour. */
export function WikiProjectPicture({ project, name }: { project: Project | undefined; name: string }) {
  if (project !== undefined) return <ProjectPicture project={project} />
  return (
    <span aria-hidden="true" style={{ backgroundColor: projectColor(name) }} className="grid size-6 shrink-0 place-items-center rounded-[8px] text-[10.5px] font-bold tracking-[0.02em] text-white">
      {projectInitials(name)}
    </span>
  )
}

/** A project the switcher offers: its folder name and path as the page knows them, and megabrain's record when megabrain lists it. */
export interface SwitcherProject {
  name: string
  path: string
  listed: Project | undefined
  /** Said after the name in the menu, as "(off)". */
  note?: string
  onSelect: () => void
}

const dressOf = (option: Pick<SwitcherProject, 'name' | 'path' | 'listed'>) => option.listed ?? { name: option.name, path: option.path }

/** The name the sidebar shows for a project: the one the person chose, else its folder's. */
export const switcherName = (option: Pick<SwitcherProject, 'name' | 'path' | 'listed'>) => displayName(dressOf(option))

/**
 * The bar's first control: the project shown, its picture and name, opening a menu of every project
 * the page has, each with its picture and name, alphabetical by name. Its hover fill overhangs the
 * page inset by 3px, so the picture starts on it.
 */
export function ProjectSwitcher({ current, options }: { current: Pick<SwitcherProject, 'name' | 'path' | 'listed'>; options: SwitcherProject[] }) {
  const { menu, open, close } = useContextMenu()
  const name = switcherName(current)
  const rows = byDisplayName(options, dressOf).map((option) => {
    const label = switcherName(option)
    return {
      label: option.note === undefined ? label : `${label} (${option.note})`,
      title: option.path,
      leading: <WikiProjectPicture project={option.listed} name={label} />,
      onSelect: option.onSelect,
    }
  })
  return (
    <>
      <button
        type="button"
        onClick={(event) => open(event, [rows])}
        aria-haspopup="menu"
        title={`${name}\n${current.path}`}
        className="-ml-[3px] flex h-[30px] max-w-[240px] min-w-0 shrink-0 items-center gap-2 rounded-full pr-2 pl-[3px] text-left transition-colors select-none hover:bg-white/[0.08]"
      >
        <WikiProjectPicture project={current.listed} name={name} />
        <span className="min-w-0 truncate text-[13px] font-semibold tracking-[-0.01em] text-ink-200 @max-[520px]/header:hidden">{name}</span>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-ink-400">
          <path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3" />
        </svg>
      </button>
      <ContextMenu menu={menu} onClose={close} />
    </>
  )
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** A section's count beside its heading. */
export const SectionCount = ({ count }: { count: number }) => <span className="text-[12px] text-ink-500 tabular-nums">{count}</span>

/** A rounded box of rows split by hairlines. */
export const listBox = 'divide-y divide-white/[0.05] overflow-hidden rounded-[20px] border border-white/[0.07] bg-ink-900/60'

/** The reading column with nothing to read: why, and what to do about it. */
export function Blank({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={`${column} pt-24 text-center`}>
      <h1 className="text-[18px] font-semibold tracking-[-0.01em] text-ink-100">{title}</h1>
      <p className="mx-auto mt-2 max-w-[420px] text-[13.5px] leading-relaxed text-ink-400">{children}</p>
    </div>
  )
}
