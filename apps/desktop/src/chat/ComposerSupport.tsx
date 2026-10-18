import { useEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { convertFileSrc } from '@tauri-apps/api/core'
import { api } from '@/api'
import { Spinner } from '@/components/ui'
import { native } from '@/lib/surface'
import { attachmentKind } from '@/chat/composer-model'
import { initialQueueState, queueReducer, type QueueAction, type QueueState } from '@/chat/queue-model'
import type { Banner } from '@/chat/composer-look'
import { DockDismiss, DockRow, DockAction } from '@/chat/ComposerDock'
import { Tooltip } from '@/components/Tooltip'

// An image or PDF going with the next message. Pasted and picked files are saved through
// saveAttachment when the message is sent; a file dropped on the window already has a path.
export type Attachment = { id: string; kind: 'image' | 'pdf'; name: string; named: boolean } & (
  | { source: 'file'; file: File; extension: string; preview: string | null }
  | { source: 'path'; path: string }
)

let attachmentSequence = 0

export function fromFile(file: File): Attachment | null {
  const accepted = attachmentKind(file.type, file.name)
  if (accepted === null) return null
  attachmentSequence += 1
  const preview = accepted.kind === 'image' ? URL.createObjectURL(file) : null
  return { id: `a${attachmentSequence}`, kind: accepted.kind, name: file.name === '' ? `pasted.${accepted.extension}` : file.name, named: file.name !== '', source: 'file', file, extension: accepted.extension, preview }
}

export function fromPath(path: string): Attachment | null {
  const name = path.split('/').at(-1) ?? path
  const accepted = attachmentKind('', name)
  if (accepted === null) return null
  attachmentSequence += 1
  return { id: `a${attachmentSequence}`, kind: accepted.kind, name, named: true, source: 'path', path }
}

/** What a thumbnail shows: the object URL of a pasted or picked image, or a local file through the asset protocol. */
export function previewOf(attachment: Attachment): string | null {
  if (attachment.kind !== 'image') return null
  if (attachment.source === 'file') return attachment.preview
  return native ? convertFileSrc(attachment.path) : null
}

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

export async function attachmentPath(attachment: Attachment): Promise<string> {
  if (attachment.source === 'path') return attachment.path
  return api.saveAttachment(await base64Of(attachment.file), attachment.extension)
}

export function releasePreview(attachment: Attachment) {
  if (attachment.source === 'file' && attachment.preview !== null) URL.revokeObjectURL(attachment.preview)
}

/** A dispatch chat's queue: read now, then every 2 seconds while anything waits; unqueue on Esc. */
export function useChatQueue(dispatchId: string | undefined, sent: number): [QueueState, (action: QueueAction) => void] {
  const [state, dispatch] = useReducer(queueReducer, initialQueueState)
  useEffect(() => {
    if (dispatchId === undefined) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const items = await api.queued(dispatchId)
        if (stopped) return
        dispatch({ type: 'refresh', items })
        if (items.some((item) => item.state === 'outstanding')) timer = setTimeout(tick, 2_000)
      } catch {
        // The queue is a convenience; a failed read leaves the last known pills.
      }
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [dispatchId, sent])
  useEffect(() => {
    const id = state.taking
    if (id === null) return
    api.unqueue(id).then(
      (text) => dispatch({ type: 'restored', id, text }),
      () => dispatch({ type: 'restore-failed', id }),
    )
  }, [state.taking])
  return [state, dispatch]
}

export function QueuePills({ state, empty }: { state: QueueState; empty: boolean }) {
  if (state.pending.length === 0 && state.taking === null && state.hint === null) return null
  return (
    <div className="-mx-1 mb-1.5 flex flex-wrap items-center gap-1.5 px-1">
      {state.pending.map((item) => (
        <Tooltip key={item.id} text={item.text}>
          {(tip) => (
            <span {...tip} className="flex max-w-64 items-center gap-1.5 rounded-full border border-accent/25 bg-accent/[0.08] px-2.5 py-0.5 text-[12px] text-ink-200">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
              <span className="truncate">{item.text}</span>
            </span>
          )}
        </Tooltip>
      ))}
      {state.taking !== null && (
        <span className="flex items-center gap-1.5 text-[12px] text-ink-400">
          <Spinner />
          Taking back…
        </span>
      )}
      {state.hint !== null ? (
        <span className="text-[12px] text-ink-400">{state.hint}</span>
      ) : (
        state.pending.length > 0 && empty && <span className="text-[12px] text-ink-400">Esc takes the newest back to edit</span>
      )}
    </div>
  )
}

// The Web Speech API, as WebKit names it; not in TypeScript's DOM library.
interface SpeechResult {
  readonly isFinal: boolean
  readonly 0: { readonly transcript: string }
}
interface Recognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { readonly results: ArrayLike<SpeechResult> }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { readonly error: string }) => void) | null
  start(): void
  stop(): void
}
type RecognitionConstructor = new () => Recognition

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const scope = window as unknown as Record<string, RecognitionConstructor | undefined>
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

/** Dictation into the composer: `begin` runs as listening starts, then `write` gets the transcript so far. */
export function useDictation(begin: () => void, write: (spoken: string) => void, onError: (message: string) => void) {
  const Constructor = recognitionConstructor()
  const [listening, setListening] = useState(false)
  const recognition = useRef<Recognition | null>(null)
  useEffect(() => () => recognition.current?.stop(), [])
  const toggle = () => {
    if (Constructor === null) return
    if (recognition.current !== null) {
      recognition.current.stop()
      return
    }
    begin()
    const next = new Constructor()
    next.continuous = true
    next.interimResults = true
    next.lang = navigator.language
    next.onresult = (event) => write(Array.from(event.results, (result) => result[0].transcript).join(''))
    next.onerror = (event) => {
      if (event.error !== 'aborted' && event.error !== 'no-speech') onError(`Dictation stopped: ${event.error}.`)
    }
    next.onend = () => {
      recognition.current = null
      setListening(false)
    }
    recognition.current = next
    setListening(true)
    try {
      next.start()
    } catch (error) {
      recognition.current = null
      setListening(false)
      onError(error instanceof Error ? error.message : String(error))
    }
  }
  return { supported: Constructor !== null, listening, toggle }
}

/** An image chip's picture, floating above the chip while the pointer is on it. */
export function ChipPreview({ attachment, left, top }: { attachment: Attachment | undefined; left: number; top: number }) {
  const src = attachment === undefined ? null : previewOf(attachment)
  if (attachment === undefined || src === null) return null
  return createPortal(
    <div style={{ left, top: top - 6 }} className="popover pointer-events-none fixed z-[100] -translate-y-full p-1">
      <img src={src} alt={attachment.name} className="block max-h-40 max-w-64 rounded-lg object-contain" />
      <p className="max-w-64 truncate px-1 pt-1 text-[11px] text-ink-400">{attachment.name}</p>
    </div>,
    document.body,
  )
}

/** A notice attached to the composer's top edge: an icon, the message, Retry when a send failed, and a close. */
export function NoticeBanner({ banner, onRetry, onDismiss }: { banner: Banner; onRetry: () => void; onDismiss: () => void }) {
  const bad = banner.tone === 'bad'
  return (
    <DockRow
      tone={bad ? 'bad' : 'neutral'}
      role={banner.role}
      title={banner.text}
      icon={
        <svg viewBox="0 0 16 16" className={`size-3.5 ${bad ? 'text-bad' : 'text-ok'}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="6.25" />
          {bad ? <path d="M8 4.75v3.75M8 11.1v.15" /> : <path d="m5.5 8.2 1.75 1.75L10.6 6.4" />}
        </svg>
      }
      text={banner.text}
    >
      {banner.action === 'retry' && <DockAction label="Retry" onClick={onRetry} />}
      <DockDismiss onClick={onDismiss} />
    </DockRow>
  )
}

