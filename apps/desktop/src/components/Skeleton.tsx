import type { ReactNode } from 'react'

// Placeholders shaped like what loads into them, so nothing jumps when it arrives. Each one is
// announced once as busy; its shapes are hidden from assistive technology.

const pulse = 'animate-pulse bg-white/[0.06] motion-reduce:animate-none'

/** One line of text not loaded yet; width is a Tailwind width class. */
export function Bone({ width, className = 'h-3' }: { width: string; className?: string }) {
  return <span aria-hidden="true" className={`block rounded-full ${pulse} ${className} ${width}`} />
}

// Widths that vary row to row the way real titles do, the same every render.
const widths = ['w-[62%]', 'w-[48%]', 'w-[71%]', 'w-[55%]', 'w-[66%]', 'w-[40%]', 'w-[58%]']
const widthAt = (index: number) => widths[index % widths.length] ?? 'w-1/2'

function Busy({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={className}>
      {children}
    </div>
  )
}

/** A conversation not loaded yet: a short message from the person, then a longer answer. */
export function ConversationSkeleton({ turns = 1 }: { turns?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6 py-2">
      {Array.from({ length: turns }, (_, turn) => (
        <div key={turn} className="flex flex-col gap-6">
          <div className="flex justify-end">
            <span className={`h-9 w-[38%] rounded-[18px] ${pulse}`} />
          </div>
          <div className="flex flex-col gap-2.5">
            <Bone width="w-[82%]" />
            <Bone width="w-[64%]" />
            <Bone width="w-[73%]" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** A chat's transcript while it is read. */
export function TranscriptSkeleton() {
  return (
    <Busy label="Reading the conversation" className="mx-8 my-5">
      <ConversationSkeleton turns={2} />
    </Busy>
  )
}

/** A pane before its item is known: its header, then a conversation. */
export function PaneSkeleton() {
  return (
    <Busy label="Loading" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 px-8">
        <span aria-hidden="true" className={`size-5 rounded-full ${pulse}`} />
        <div className="flex flex-1 flex-col gap-1.5">
          <Bone width="w-[30%]" className="h-3.5" />
          <Bone width="w-[18%]" className="h-2.5" />
        </div>
      </div>
      <div className="mx-8 my-5">
        <ConversationSkeleton turns={2} />
      </div>
    </Busy>
  )
}

/** List rows: an icon, a title and a short detail at the end. */
export function RowsSkeleton({ count = 5, label = 'Loading', className = '' }: { count?: number; label?: string; className?: string }) {
  return (
    <Busy label={label} className={`grid gap-1 ${className}`}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} aria-hidden="true" className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5">
          <span className={`size-4 rounded-full ${pulse}`} />
          <Bone width={widthAt(index)} />
          <Bone width="w-10" />
        </div>
      ))}
    </Busy>
  )
}

/** The sidebar's projects before the first list: a project row, then its worktrees, twice. */
export function SidebarSkeleton() {
  return (
    <Busy label="Loading projects" className="space-y-4">
      {[3, 2].map((rows, project) => (
        <div key={project} aria-hidden="true" className="space-y-1">
          <div className="flex h-9 items-center gap-2.5 pl-2.5">
            <span className={`size-6 rounded-[8px] ${pulse}`} />
            <Bone width={project === 0 ? 'w-[45%]' : 'w-[36%]'} className="h-3.5" />
          </div>
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} className="flex h-8 items-center gap-2 pl-[15px]">
              <span className={`size-3.5 rounded-full ${pulse}`} />
              <Bone width={widthAt(index + project)} />
            </div>
          ))}
        </div>
      ))}
    </Busy>
  )
}

/** The whole window before it knows whether to show setup or the app: a sidebar and a pane. */
export function AppSkeleton() {
  return (
    <div className="flex h-full">
      <aside className="glass flex w-[280px] shrink-0 flex-col gap-4 border-r border-white/[0.06] px-2.5 pt-12">
        <SidebarSkeleton />
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-950 pt-6">
        <PaneSkeleton />
      </main>
    </div>
  )
}

/** Settings rows: a label with its description, and a control at the end. */
export function SettingRowsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <Busy label="Loading settings" className="divide-y divide-white/[0.06] rounded-[20px] border border-white/[0.08] bg-ink-900">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex items-center gap-4 px-4 py-3.5">
          <div className="flex flex-1 flex-col gap-2">
            <Bone width={index % 2 === 0 ? 'w-[28%]' : 'w-[22%]'} className="h-3.5" />
            <Bone width={widthAt(index)} className="h-2.5" />
          </div>
          <span className={`h-7 w-20 rounded-full ${pulse}`} />
        </div>
      ))}
    </Busy>
  )
}

/** A settings page before it loads: its title, then a card of rows. */
export function SettingsSkeleton() {
  return (
    <Busy label="Loading settings" className="flex flex-col gap-6">
      <div aria-hidden="true" className="flex items-center gap-3">
        <span className={`size-9 rounded-[12px] ${pulse}`} />
        <div className="flex flex-1 flex-col gap-2">
          <Bone width="w-[24%]" className="h-4" />
          <Bone width="w-[52%]" className="h-2.5" />
        </div>
      </div>
      <SettingRowsSkeleton />
    </Busy>
  )
}

/** A file tree before it loads: folders and files, indented. */
export function TreeSkeleton() {
  const depths = [0, 0, 1, 1, 2, 1, 0, 1, 0]
  return (
    <Busy label="Loading files" className="space-y-2 p-3">
      {depths.map((depth, index) => (
        <div key={index} aria-hidden="true" style={{ paddingLeft: depth * 14 }} className="flex items-center gap-2">
          <span className={`size-3 rounded-[4px] ${pulse}`} />
          <Bone width={widthAt(index)} />
        </div>
      ))}
    </Busy>
  )
}

/** A file's text before it loads: numbered lines of code. */
export function CodeSkeleton() {
  const lines = ['w-[34%]', 'w-[52%]', 'w-[61%]', 'w-[18%]', 'w-0', 'w-[44%]', 'w-[70%]', 'w-[57%]', 'w-[26%]', 'w-0', 'w-[48%]', 'w-[63%]']
  return (
    <Busy label="Loading the file" className="space-y-2.5 p-5">
      {lines.map((width, index) => (
        <div key={index} aria-hidden="true" className="flex items-center gap-4">
          <span className="w-5 text-right font-mono text-[11px] text-ink-600">{index + 1}</span>
          {width !== 'w-0' && <Bone width={width} />}
        </div>
      ))}
    </Busy>
  )
}

/** A pull request or issue before its detail loads: the description card, then two comments. */
export function DetailSkeleton() {
  return (
    <Busy label="Reading the description and comments" className="space-y-4">
      <div aria-hidden="true" className="space-y-2.5 rounded-[20px] border border-white/[0.08] bg-ink-900 px-5 py-4">
        <Bone width="w-[78%]" />
        <Bone width="w-[66%]" />
        <Bone width="w-[71%]" />
        <Bone width="w-[40%]" />
      </div>
      {[0, 1].map((index) => (
        <div key={index} aria-hidden="true" className="flex gap-3">
          <span className={`size-7 shrink-0 rounded-full ${pulse}`} />
          <div className="flex flex-1 flex-col gap-2 pt-1">
            <Bone width="w-[22%]" className="h-2.5" />
            <Bone width={widthAt(index + 2)} />
            <Bone width={widthAt(index + 4)} />
          </div>
        </div>
      ))}
    </Busy>
  )
}

/** A short text block (a report, a reply) while it is read. */
export function TextSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <Busy label="Reading" className="space-y-2 py-1">
      {Array.from({ length: lines }, (_, index) => (
        <Bone key={index} width={widthAt(index + 1)} />
      ))}
    </Busy>
  )
}
