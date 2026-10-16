import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { Project, ProjectScripts } from '@/api/schema'
import { partitionHidden } from '@/advanced/sidebar-model'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { RowsSkeleton, SettingRowsSkeleton } from '@/components/Skeleton'
import { Button, ErrorNote, Spinner } from '@/components/ui'
import { runActionLabel, runActions, type RunAction } from '@/run-panel/run-model'
import { field } from '@/settings/settings-ui'

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
function ProjectCommands({ project, focused }: { project: Project; focused: boolean }) {
  const [scripts, setScripts] = useState<ProjectScripts | null>(null)
  const [form, setForm] = useState<Form>({ run: '', build: '', install: '' })
  const [error, setError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const card = useRef<HTMLElement>(null)

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

  useEffect(() => {
    if (focused) card.current?.scrollIntoView({ block: 'start' })
  }, [focused])

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
    <section ref={card} aria-label={project.name} className={`scroll-mt-4 rounded-[16px] border bg-ink-900/80 transition-colors duration-150 motion-reduce:transition-none ${focused ? 'border-accent/40 ring-2 ring-accent/15' : 'border-white/[0.08]'}`}>
      <header className="flex items-center gap-3 px-4 pt-3.5 pb-3">
        <ProjectPicture project={project} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13.5px] font-semibold text-ink-100">{project.name}</h3>
          <p title={project.path} className="truncate font-mono text-[11.5px] text-ink-500">
            {project.path}
          </p>
        </div>
      </header>
      {scripts === null && error === null ? (
        <div className="border-t border-white/[0.06] p-3">
          <RowsSkeleton count={3} label={`Reading the commands of ${project.name}`} />
        </div>
      ) : (
        <form
          className="divide-y divide-white/[0.06] border-t border-white/[0.06]"
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
    </section>
  )
}

/** Each project's commands for the run button in a chat's top bar; every worktree of a project shares them. */
export function ProjectsSection({ focusProject }: { focusProject: string | null }) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    api.projects('megabrain').then(
      (next) => setProjects(partitionHidden(next).visible.filter((project) => !project.missing)),
      (caught: unknown) => setError(caught),
    )
  }, [])

  if (error !== null) return <ErrorNote error={error} />
  if (projects === null) return <SettingRowsSkeleton count={3} />
  if (projects.length === 0) return <p className="px-1 text-[13px] text-ink-400">No projects yet. Import one from the sidebar to give it commands.</p>
  return (
    <>
      <p className="-mt-2 px-1 text-[12.5px] text-ink-400">They run in the chat's worktree. Leave a field empty to use the detected command.</p>
      {projects.map((project) => (
        <ProjectCommands key={project.path} project={project} focused={project.path === focusProject} />
      ))}
    </>
  )
}
