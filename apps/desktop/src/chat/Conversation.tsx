import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { Transcript } from '@/api/schema'
import { ErrorNote } from '@/components/ui'

// Placeholder: the conversation view (messages, collapsible thinking, tool calls) is its own piece
// of work. It reads `api.transcript` and follows new events through the returned cursor.
export function Conversation({ target, live }: { target: { dispatchId: string } | { sessionId: string }; live: boolean }) {
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [error, setError] = useState<unknown>(null)
  const key = 'dispatchId' in target ? target.dispatchId : target.sessionId
  useEffect(() => {
    api.transcript(target).then(setTranscript, setError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live])
  if (error !== null) return <div className="mx-8 my-5"><ErrorNote error={error} /></div>
  return (
    <ol className="mx-8 my-5 min-h-0 flex-1 space-y-2 overflow-y-auto text-[14px] text-ink-300 select-text">
      {transcript?.events.map((event) => (
        <li key={event.id}>
          <span className="text-ink-500">{event.kind}</span> {event.text}
        </li>
      ))}
    </ol>
  )
}
