import type { ReactNode } from 'react'
import { ConversationSkeleton } from '@/components/Skeleton'
import { Button, ErrorNote, Spinner } from '@/components/ui'
import type { PendingEntry } from '@/lib/pending-model'

/**
 * Something starting in this pane: what it is while it runs, its error with a retry when it fails.
 * Below it, the shape of the conversation it opens into.
 */
export function StartingCard({ entry, icon, onRetry, onDismiss }: { entry: PendingEntry; icon?: ReactNode; onRetry: () => void; onDismiss: () => void }) {
  const failed = entry.status === 'failed'
  return (
    <section role="status" aria-busy={!failed} className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-[22px] border border-white/[0.08] bg-ink-900 px-5 py-4">
        {icon}
        <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink-200">{failed ? `${entry.label.replace(/^Starting/, 'Could not start')}` : `${entry.label}…`}</p>
        {failed ? (
          <span className="flex shrink-0 gap-2">
            <Button variant="ghost" className="h-8 px-3 text-[12.5px]" onClick={onDismiss}>
              Back
            </Button>
            <Button variant="primary" className="h-8 px-4 text-[12.5px]" onClick={onRetry}>
              Retry
            </Button>
          </span>
        ) : (
          <Spinner />
        )}
      </div>
      {failed && entry.error !== null && <ErrorNote error={entry.error} />}
      {!failed && <ConversationSkeleton />}
    </section>
  )
}
