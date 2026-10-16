import { useState } from 'react'
import { Dialog } from '@/components/Dialog'
import { Button, ErrorNote, Spinner } from '@/components/ui'
import { usePresence } from '@/lib/usePresence'

export interface PendingConfirm {
  title: string
  /** One line on what happens. */
  body: string
  /** The primary button's label. */
  action: string
  /** danger (the default) for anything that ends, removes or stops something. */
  tone?: 'danger' | 'primary'
  run: () => Promise<void>
}

/**
 * The one confirmation in the app (see Dialog), open while `confirm` is set and fading out after. A
 * refusal shows megabrain's own error text. A confirmation with another title starts afresh.
 */
export function ConfirmDialog({ confirm, onClose, onDone = onClose }: { confirm: PendingConfirm | null; onClose: () => void; onDone?: () => void }) {
  const { shown, leaving } = usePresence(confirm)
  if (shown === null) return null
  return <ConfirmCard key={shown.title} confirm={shown} leaving={leaving} onClose={onClose} onDone={onDone} />
}

function ConfirmCard({ confirm, leaving, onClose, onDone }: { confirm: PendingConfirm; leaving: boolean; onClose: () => void; onDone: () => void }) {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const run = () => {
    if (running) return
    setRunning(true)
    setError(null)
    confirm.run().then(
      () => {
        setRunning(false)
        onDone()
      },
      (caught: unknown) => {
        setRunning(false)
        setError(caught)
      },
    )
  }

  return (
    <Dialog title={confirm.title} busy={running} leaving={leaving} onCancel={onClose} onSubmit={run}>
      <p className="mt-2 text-[13.5px] leading-relaxed text-ink-300">{confirm.body}</p>
      {error !== null && (
        <div className="mt-4">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={running}>
          Cancel
        </Button>
        <Button data-autofocus variant={confirm.tone === 'primary' ? 'primary' : 'danger'} onClick={run} disabled={running}>
          {running ? <Spinner /> : confirm.action}
        </Button>
      </div>
    </Dialog>
  )
}
