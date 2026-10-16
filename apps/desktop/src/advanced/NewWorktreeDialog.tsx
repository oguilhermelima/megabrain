import { useId, useState } from 'react'
import type { Project } from '@/api/schema'
import { baseSuggestions, branchNameError } from '@/advanced/new-worktree-model'
import { Dialog } from '@/components/Dialog'
import { Button } from '@/components/ui'
import { usePresence } from '@/lib/usePresence'

const field =
  'mt-1.5 h-9 w-full rounded-[12px] border border-white/[0.1] bg-ink-900 px-3 font-mono text-[13px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent/60 aria-invalid:border-bad/60'

/**
 * A new worktree for a project: the branch to create and the ref it starts from. The base suggests
 * the branches the project's worktrees have checked out and takes any typed ref. Create closes the
 * dialog at once; the sidebar shows the worktree as pending until megabrain lists it.
 */
export function NewWorktreeDialog({ project, taken, onCreate, onClose }: { project: Project | null; taken: readonly string[]; onCreate: (project: Project, branch: string, base: string) => void; onClose: () => void }) {
  const { shown, leaving } = usePresence(project)
  if (shown === null) return null
  return <NewWorktreeCard key={shown.path} project={shown} taken={taken} leaving={leaving} onCreate={(branch, base) => onCreate(shown, branch, base)} onClose={onClose} />
}

function NewWorktreeCard({ project, taken, leaving, onCreate, onClose }: { project: Project; taken: readonly string[]; leaving: boolean; onCreate: (branch: string, base: string) => void; onClose: () => void }) {
  const bases = baseSuggestions(project)
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState(bases.initial)
  const [tried, setTried] = useState(false)
  const listId = useId()
  const branchId = useId()
  const baseId = useId()
  const existing = [...bases.suggestions, ...taken]
  const branchError = branchNameError(branch, existing)
  const baseError = base.trim() === '' ? 'Pick the branch or ref to start from.' : null
  // The name is judged once something is typed, or after a Create with nothing in it.
  const shownError = branch !== '' || tried ? branchError : null

  const submit = () => {
    setTried(true)
    if (branchError !== null || baseError !== null) return
    onCreate(branch.trim(), base.trim())
  }

  return (
    <Dialog title={`New worktree in ${project.name}`} busy={false} leaving={leaving} onCancel={onClose} onSubmit={submit}>
      <div className="mt-4 space-y-4">
        <label htmlFor={branchId} className="block text-[12.5px] font-medium text-ink-300">
          Branch
          <input
            id={branchId}
            data-autofocus
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="feat/my-change"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={shownError !== null}
            aria-describedby={shownError === null ? undefined : `${branchId}-error`}
            className={field}
          />
        </label>
        {shownError !== null && (
          <p id={`${branchId}-error`} role="alert" className="-mt-2.5 text-[12px] text-bad">
            {shownError}
          </p>
        )}
        <label htmlFor={baseId} className="block text-[12.5px] font-medium text-ink-300">
          From
          <input
            id={baseId}
            list={listId}
            value={base}
            onChange={(event) => setBase(event.target.value)}
            placeholder="main"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-invalid={tried && baseError !== null}
            className={field}
          />
          <datalist id={listId}>
            {bases.suggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        {tried && baseError !== null && (
          <p role="alert" className="-mt-2.5 text-[12px] text-bad">
            {baseError}
          </p>
        )}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={tried && (branchError !== null || baseError !== null)}>
          Create
        </Button>
      </div>
    </Dialog>
  )
}
