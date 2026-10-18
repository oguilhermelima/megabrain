import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { ArchivedWorktree, Project, ProjectScripts } from '@/api/schema'
import type { ProjectAppearancePatch } from '@/api/adapter'
import { customPicture, displayName, droppedPicture, nameEdit, projectTint, tintSwatches } from '@/advanced/appearance-model'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { relativeAge } from '@/advanced/projects-model'
import { RowsSkeleton } from '@/components/Skeleton'
import { Button, ErrorNote, Spinner } from '@/components/ui'
import { useWindowDrop } from '@/lib/window-drop'
import { runActionLabel, runActions, type RunAction } from '@/run-panel/run-model'
import { field, quiet } from '@/settings/settings-ui'

type Form = Record<RunAction, string>

const savedForm = (scripts: ProjectScripts): Form => ({
  run: scripts.scripts.run?.source === 'saved' ? scripts.scripts.run.command : '',
  build: scripts.scripts.build?.source === 'saved' ? scripts.scripts.build.command : '',
  install: scripts.scripts.install?.source === 'saved' ? scripts.scripts.install.command : '',
})

/**
 * One project's Run, Build and Install commands. A field holds the saved command; an empty field
 * leaves it to detection, whose command shows as the placeholder. Save sends only what changed,
 * and clearing a field returns it to detection.
 */
function Runners({ project }: { project: Project }) {
  const [scripts, setScripts] = useState<ProjectScripts | null>(null)
  const [form, setForm] = useState<Form>({ run: '', build: '', install: '' })
  const [error, setError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let current = true
    api.projectScripts(project.path).then(
      (next) => {
        if (!current) return
        setScripts(next)
        setForm(savedForm(next))
      },
      (caught: unknown) => {
        if (current) setError(caught)
      },
    )
    return () => {
      current = false
    }
  }, [project.path])

  const saved = scripts === null ? null : savedForm(scripts)
  const changes = saved === null ? {} : Object.fromEntries(runActions.filter((action) => form[action].trim() !== saved[action]).map((action) => [action, form[action].trim()]))
  const dirty = Object.keys(changes).length > 0

  const save = async () => {
    setSaving(true)
    try {
      const next = await api.setProjectScripts(project.path, changes)
      setScripts(next)
      setForm(savedForm(next))
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-label="Runners" className="grid gap-2">
      <header className="flex min-h-7 items-center px-1">
        <h3 className="text-[12px] font-semibold tracking-[0.04em] text-ink-400 uppercase">Runners</h3>
      </header>
      <p className="-mt-1 px-1 text-[12.5px] text-ink-400">They run in the chat's worktree. Leave a field empty to use the detected command.</p>
      <div className="rounded-[16px] border border-white/[0.08] bg-ink-900/80">
      {scripts === null && error === null ? (
        <div className="p-3">
          <RowsSkeleton count={3} label={`Reading the commands of ${displayName(project)}`} />
        </div>
      ) : (
        <form
          className="divide-y divide-white/[0.06]"
          onSubmit={(event) => {
            event.preventDefault()
            if (dirty && !saving) void save()
          }}
        >
          {runActions.map((action) => {
            const entry = scripts?.scripts[action] ?? null
            const detected = entry?.source === 'detected' ? entry.command : undefined
            const id = `${project.path}:${action}`
            return (
              <div key={action} className="flex items-center gap-4 px-4 py-2.5">
                <label htmlFor={id} className="flex w-24 shrink-0 flex-col">
                  <span className="text-[13px] font-medium text-ink-100">{runActionLabel[action]}</span>
                  <span className="text-[11.5px] text-ink-500">{form[action].trim() === '' ? (detected !== undefined ? 'detected' : 'not set') : form[action].trim() === saved?.[action] ? 'saved' : 'edited'}</span>
                </label>
                <input
                  id={id}
                  value={form[action]}
                  onChange={(event) => setForm((current) => ({ ...current, [action]: event.target.value }))}
                  placeholder={detected ?? (entry === null ? 'Nothing detected; type a command' : 'Empty uses the detected command')}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className={`${field} flex-1 font-mono text-[12.5px]`}
                />
              </div>
            )
          })}
          <div className="flex min-h-12 items-center justify-end gap-2 px-4 py-2.5">
            {dirty && (
              <Button variant="ghost" className="h-8 px-4 text-[13px]" onClick={() => saved !== null && setForm(saved)} disabled={saving}>
                Revert
              </Button>
            )}
            <Button type="submit" variant="primary" className="h-8 px-4 text-[13px]" disabled={!dirty || saving}>
              {saving ? <Spinner /> : 'Save'}
            </Button>
          </div>
        </form>
      )}
      {error !== null && (
        <div className="border-t border-white/[0.06] p-4">
          <ErrorNote error={error} />
        </div>
      )}
      </div>
    </section>
  )
}

/**
 * The project's picture as one block: a 64px preview that picks an image when pressed or takes one
 * dropped on it, Change under it, and Remove on its corner once the person has chosen a picture (the
 * detected one cannot be removed, only replaced).
 */
function PictureBlock({ project, busy, onSet, onError }: { project: Project; busy: boolean; onSet: (picture: string | null) => void; onError: (error: unknown) => void }) {
  const block = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const chosen = customPicture(project) !== null
  const name = displayName(project)

  const choose = async () => {
    try {
      const path = await api.pickImage()
      if (path !== null) onSet(path)
    } catch (caught) {
      onError(caught)
    }
  }

  useWindowDrop(
    {
      onDrop: (paths, x, y) => {
        const target = document.elementFromPoint(x, y)
        if (busy || target === null || block.current?.contains(target) !== true) return
        const picture = droppedPicture(paths)
        if (picture === null) onError(new Error('Drop one image: PNG, JPEG, WebP or SVG.'))
        else onSet(picture)
      },
      onHover: setDragging,
    },
    true,
  )

  return (
    <div ref={block} className="flex shrink-0 flex-col items-center gap-1">
      <div className="relative">
        <button type="button" onClick={() => void choose()} disabled={busy} title="Choose a picture, or drop an image here" aria-label={`Change the picture of ${name}`} className={`block rounded-[20px] transition-[opacity,box-shadow] duration-100 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50 motion-reduce:transition-none ${dragging ? 'ring-2 ring-accent/70 ring-offset-2 ring-offset-ink-900' : ''}`}>
          <ProjectPicture project={project} size="hero" />
        </button>
        {chosen && (
          <button type="button" onClick={() => onSet(null)} disabled={busy} title="Remove the picture" aria-label={`Remove the picture of ${name}`} className="absolute -top-1.5 -right-1.5 grid size-6 place-items-center rounded-full border border-white/[0.14] bg-ink-800 text-ink-300 shadow-sm transition-colors hover:bg-ink-700 hover:text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50">
            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
            </svg>
          </button>
        )}
      </div>
      <button type="button" onClick={() => void choose()} disabled={busy} className="rounded-full px-2 py-0.5 text-[11.5px] font-medium text-ink-400 transition-colors hover:bg-white/[0.06] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:opacity-50">
        Change
      </button>
    </div>
  )
}

const swatch = 'grid size-6 shrink-0 place-items-center rounded-full ring-offset-2 ring-offset-ink-900 transition-shadow duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none'

/**
 * Who the project is in megabrain: its picture, display name and colour, each kept by megabrain
 * only. Clearing the name, removing the picture or choosing None returns to what is detected.
 */
function Appearance({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [name, setName] = useState(project.appearance?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const tint = projectTint(project)
  // The colour picker reports every step of a drag; only the colour it settles on is saved.
  const [customDraft, setCustomDraft] = useState<string | null>(null)
  const custom = tint !== null && !tintSwatches.includes(tint.toLowerCase())

  useEffect(() => setName(project.appearance?.name ?? ''), [project.appearance?.name])

  const save = async (patch: ProjectAppearancePatch) => {
    setBusy(true)
    try {
      await api.setProjectAppearance(project.path, patch)
      setError(null)
      onChanged()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const commitName = () => {
    const next = nameEdit(project, name)
    setName(next ?? '')
    if (next !== nameEdit(project, project.appearance?.name ?? '')) void save({ name: next })
  }

  return (
    <section aria-label="Appearance" className="grid gap-3">
      <header className="flex items-center gap-4">
        <PictureBlock project={project} busy={busy} onSet={(picture) => void save({ picture })} onError={setError} />
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                event.stopPropagation()
                setName(project.appearance?.name ?? '')
              }
            }}
            placeholder={project.name}
            aria-label="Display name"
            title="The name megabrain shows; the repository keeps its own. Clear it to use the folder's name."
            spellCheck={false}
            disabled={busy}
            className="-mx-1.5 w-full rounded-[8px] not-focus:text-ellipsis border border-transparent bg-transparent px-1.5 text-[17px] font-semibold tracking-[-0.01em] text-ink-100 placeholder:text-ink-100 hover:border-white/[0.08] focus:border-accent/60 focus:outline-none"
          />
          <p title={project.path} className="truncate font-mono text-[11.5px] text-ink-500 select-text">
            {project.path}
          </p>
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-2 px-1" role="radiogroup" aria-label="Colour of the agent marks">
        <span className="mr-1 text-[12.5px] text-ink-400">Agent colour</span>
        <button type="button" role="radio" aria-checked={tint === null} aria-label="None" title="None: agents keep their own colours" onClick={() => tint !== null && void save({ color: null })} disabled={busy} className={`${swatch} border border-white/[0.2] text-ink-400 ${tint === null ? 'ring-2 ring-white/60' : ''}`}>
          <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M4 12 12 4" />
          </svg>
        </button>
        {tintSwatches.map((color) => {
          const chosen = tint?.toLowerCase() === color
          return <button key={color} type="button" role="radio" aria-checked={chosen} aria-label={color} title={color} onClick={() => !chosen && void save({ color })} disabled={busy} style={{ backgroundColor: color }} className={`${swatch} ${chosen ? 'ring-2 ring-white/60' : ''}`} />
        })}
        <label title="Custom colour" className={`${swatch} relative cursor-pointer overflow-hidden border border-white/[0.2] ${custom || customDraft !== null ? 'ring-2 ring-white/60' : ''}`} style={customDraft !== null || custom ? { backgroundColor: customDraft ?? tint ?? undefined } : { background: 'conic-gradient(#ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)' }}>
          <input
            type="color"
            aria-label="Custom colour"
            value={customDraft ?? tint ?? '#888888'}
            disabled={busy}
            onChange={(event) => setCustomDraft(event.target.value)}
            onBlur={() => {
              if (customDraft !== null && customDraft !== tint) void save({ color: customDraft })
              setCustomDraft(null)
            }}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        {busy && <Spinner />}
      </div>
      {error !== null && <ErrorNote error={error} />}
    </section>
  )
}

function archivedWhen(iso: string): string {
  const age = relativeAge(iso, Date.now())
  return age === 'now' ? 'archived just now' : `archived ${age} ago`
}

/** Branches whose worktree megabrain archived from the sidebar; Restore recreates each where it was. */
function ArchivedBranches({ project }: { project: Project }) {
  const [archived, setArchived] = useState<ArchivedWorktree[] | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  const load = () =>
    api.archivedWorktrees(project.path).then(
      (next) => {
        setArchived([...next].sort((left, right) => right.archivedAt.localeCompare(left.archivedAt)))
        setError(null)
      },
      (caught: unknown) => setError(caught),
    )

  useEffect(() => void load(), [project.path])

  const restore = async (branch: string) => {
    setRestoring(branch)
    try {
      await api.unarchiveWorktree(project.path, branch)
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      setRestoring(null)
      await load()
    }
  }

  return (
    <section aria-label="Archived branches" className="grid gap-2">
      <header className="flex min-h-7 items-center px-1">
        <h3 className="text-[12px] font-semibold tracking-[0.04em] text-ink-400 uppercase">Archived branches</h3>
      </header>
      {archived === null && error === null ? (
        <RowsSkeleton count={2} label={`Reading the archived branches of ${displayName(project)}`} />
      ) : archived !== null && archived.length === 0 ? (
        <p className="px-1 text-[12.5px] text-ink-400">None. Archive a branch from its menu in the sidebar to put its folder away and keep the branch.</p>
      ) : (
        archived !== null && (
          <ul className="divide-y divide-white/[0.06] rounded-[16px] border border-white/[0.08] bg-ink-900/80">
            {archived.map((entry) => (
              <li key={entry.branch} className="flex min-h-12 items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p title={entry.branch} className="truncate font-mono text-[12.5px] text-ink-100">
                    {entry.branch}
                  </p>
                  <p className="text-[11.5px] text-ink-500">
                    <time dateTime={entry.archivedAt} title={new Date(entry.archivedAt).toLocaleString()}>
                      {archivedWhen(entry.archivedAt)}
                    </time>
                    {entry.parent !== null && entry.parent !== undefined && ` · on ${entry.parent}`}
                  </p>
                </div>
                {entry.pullRequest !== null && entry.pullRequest !== undefined && (
                  <span className="shrink-0 font-mono text-[11.5px] text-ink-400" title={entry.pullRequest.state === undefined ? undefined : `Pull request ${entry.pullRequest.state.toLowerCase()}`}>
                    #{entry.pullRequest.number}
                  </span>
                )}
                <button type="button" className={quiet} onClick={() => void restore(entry.branch)} disabled={restoring !== null}>
                  {restoring === entry.branch ? <Spinner /> : 'Restore'}
                </button>
              </li>
            ))}
          </ul>
        )
      )}
      {error !== null && <ErrorNote error={error} />}
    </section>
  )
}

/** One project's page in Settings: who it is, the commands its chats run, and its archived branches. */
export function ProjectPage({ project, onChanged }: { project: Project; onChanged: () => void }) {
  return (
    <div className="grid gap-6">
      <Appearance project={project} onChanged={onChanged} />
      <Runners project={project} />
      <ArchivedBranches project={project} />
    </div>
  )
}
