import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { GithubProject, GithubProjectStatusUpdate, GithubProjectStatusUpdateStatus, GithubProjectWorkflows } from '@/api/schema'
import { Dialog } from '@/components/Dialog'
import { ErrorNote } from '@/components/ui'
import { pillButton } from '@/github/page-parts'
import { statusColors } from '@/tasks/board-model'

// The board's header actions: the project's status update (the latest, and a form to post a new one
// to GitHub) and its workflows, listed read-only. GitHub's Insights has no API, so it is not here.

const statusNames: Record<GithubProjectStatusUpdateStatus, string> = { ON_TRACK: 'On track', AT_RISK: 'At risk', OFF_TRACK: 'Off track', COMPLETE: 'Complete', INACTIVE: 'Inactive' }
const statusTones: Record<GithubProjectStatusUpdateStatus, string> = { ON_TRACK: statusColors.GREEN, AT_RISK: statusColors.YELLOW, OFF_TRACK: statusColors.RED, COMPLETE: statusColors.PURPLE, INACTIVE: statusColors.GRAY }
const field = 'h-9 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.05] px-2.5 text-[13px] text-ink-100 outline-none focus:border-accent/60'

function StatusDialog({ root, project, onClose }: { root: string; project: GithubProject; onClose: () => void }) {
  const [latest, setLatest] = useState<GithubProjectStatusUpdate | null | undefined>(undefined)
  const [error, setError] = useState<unknown>(null)
  const [status, setStatus] = useState<GithubProjectStatusUpdateStatus>('ON_TRACK')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    api.githubProjectStatus(root, project.number, project.owner).then(
      (result) => current && setLatest([...result.updates].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null),
      (cause: unknown) => current && setError(cause),
    )
    return () => {
      current = false
    }
  }, [root, project.number, project.owner])
  const post = () => {
    setBusy(true)
    setError(null)
    api.githubProjectStatusCreate(root, project.number, status, body.trim() === '' ? undefined : body.trim(), undefined, undefined, project.owner).then(
      (update) => {
        setLatest(update)
        setBody('')
        setBusy(false)
      },
      (cause: unknown) => {
        setError(cause)
        setBusy(false)
      },
    )
  }
  return (
    <Dialog title="Status update" busy={busy} onCancel={onClose} onSubmit={post}>
      <div className="space-y-4">
        {latest === undefined ? (
          error === null && <p className="text-[13px] text-ink-500">Reading the latest update…</p>
        ) : latest === null ? (
          <p className="text-[13px] text-ink-500">No status update yet.</p>
        ) : (
          <div className="space-y-1.5 rounded-[12px] border border-white/[0.07] p-3">
            <p className="flex items-center gap-2 text-[12.5px]">
              <span aria-hidden="true" style={{ backgroundColor: statusTones[latest.status] }} className="size-2.5 rounded-full" />
              <span className="font-semibold text-ink-100">{statusNames[latest.status]}</span>
              <span className="text-ink-500">
                {new Date(latest.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                {latest.creator !== null && ` · ${latest.creator}`}
              </span>
            </p>
            {latest.body !== '' && <p className="text-[12.5px] whitespace-pre-wrap text-ink-300">{latest.body}</p>}
          </div>
        )}
        {error !== null && <ErrorNote error={error} />}
        <label className="block space-y-1 text-[12px] text-ink-400">
          New status
          <select data-autofocus value={status} onChange={(event) => setStatus(event.target.value as GithubProjectStatusUpdateStatus)} style={{ colorScheme: 'dark' }} className={field}>
            {(Object.keys(statusNames) as GithubProjectStatusUpdateStatus[]).map((value) => (
              <option key={value} value={value}>
                {statusNames[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-[12px] text-ink-400">
          Update
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={4} className={`${field} h-auto py-2`} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={pillButton}>
            Close
          </button>
          <button type="button" disabled={busy} onClick={post} className="rounded-full bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-950 disabled:opacity-50">
            Post update
          </button>
        </div>
      </div>
    </Dialog>
  )
}

function WorkflowsDialog({ root, project, onClose }: { root: string; project: GithubProject; onClose: () => void }) {
  const [workflows, setWorkflows] = useState<GithubProjectWorkflows['workflows'] | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    let current = true
    api.githubProjectWorkflows(root, project.number, project.owner).then(
      (result) => current && setWorkflows([...result.workflows].sort((a, b) => a.number - b.number)),
      (cause: unknown) => current && setError(cause),
    )
    return () => {
      current = false
    }
  }, [root, project.number, project.owner])
  return (
    <Dialog title="Workflows" busy={false} onCancel={onClose} onSubmit={onClose}>
      <div className="space-y-3">
        {error !== null && <ErrorNote error={error} />}
        {workflows === null ? (
          error === null && <p className="text-[13px] text-ink-500">Reading workflows…</p>
        ) : workflows.length === 0 ? (
          <p className="text-[13px] text-ink-500">This project has no workflows.</p>
        ) : (
          <ul className="space-y-1">
            {workflows.map((workflow) => (
              <li key={workflow.id} className="flex items-center gap-2 text-[13px]">
                <span aria-hidden="true" className={`size-2 rounded-full ${workflow.enabled ? 'bg-ok' : 'bg-ink-600'}`} />
                <span className="min-w-0 flex-1 truncate text-ink-100">{workflow.name}</span>
                <span className="text-[12px] text-ink-500">{workflow.enabled ? 'Enabled' : 'Disabled'}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12px] text-ink-500">Workflows are changed on GitHub.</p>
        <div className="flex justify-end">
          <button type="button" data-autofocus onClick={onClose} className={pillButton}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  )
}

export function ProjectActions({ root, project }: { root: string; project: GithubProject }) {
  const [open, setOpen] = useState<'status' | 'workflows' | null>(null)
  const close = () => setOpen(null)
  return (
    <>
      <button type="button" onClick={() => setOpen('status')} className={pillButton}>
        Status update
      </button>
      <button type="button" onClick={() => setOpen('workflows')} className={pillButton}>
        Workflows
      </button>
      {open === 'status' && <StatusDialog root={root} project={project} onClose={close} />}
      {open === 'workflows' && <WorkflowsDialog root={root} project={project} onClose={close} />}
    </>
  )
}
