import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { api } from '@/api'
import type { SlashCommand } from '@/api/schema'
import { Spinner } from '@/components/ui'
import { native } from '@/lib/surface'
import { appendAttachmentPaths, attachmentKind, filterSlashCommands, insertSlashCommand, slashQuery } from '@/chat/composer-model'
import { initialQueueState, queueReducer, type QueueAction, type QueueState } from '@/chat/queue-model'

export type Notice = { tone: 'ok' | 'bad'; text: string }

// Slash commands per agent and folder, read once per app run.
const commandCache = new Map<string, Promise<SlashCommand[]>>()

function loadCommands(agent: string, cwd: string): Promise<SlashCommand[]> {
  const key = `${agent}\n${cwd}`
  const cached = commandCache.get(key)
  if (cached !== undefined) return cached
  const loading = api.slashCommands(agent, cwd).catch((error: unknown) => {
    commandCache.delete(key)
    throw error
  })
  commandCache.set(key, loading)
  return loading
}

function useSlashCommands(agent: string | null, cwd: string | null): SlashCommand[] {
  const [commands, setCommands] = useState<SlashCommand[]>([])
  useEffect(() => {
    if (agent === null || agent === '' || cwd === null || cwd === '') return
    let stopped = false
    loadCommands(agent, cwd).then(
      (list) => {
        if (!stopped) setCommands(list)
      },
      () => {
        if (!stopped) setCommands([])
      },
    )
    return () => {
      stopped = true
    }
  }, [agent, cwd])
  return commands
}

// An image or PDF going with the next message. Pasted and picked files are saved through
// saveAttachment when the message is sent; a file dropped on the window already has a path.
type Attachment = { id: string; kind: 'image' | 'pdf'; name: string } & (
  | { source: 'file'; file: File; extension: string; preview: string | null }
  | { source: 'path'; path: string }
)

let attachmentSequence = 0

function fromFile(file: File): Attachment | null {
  const accepted = attachmentKind(file.type, file.name)
  if (accepted === null) return null
  attachmentSequence += 1
  const preview = accepted.kind === 'image' ? URL.createObjectURL(file) : null
  return { id: `a${attachmentSequence}`, kind: accepted.kind, name: file.name === '' ? `pasted.${accepted.extension}` : file.name, source: 'file', file, extension: accepted.extension, preview }
}

function fromPath(path: string): Attachment | null {
  const name = path.split('/').at(-1) ?? path
  const accepted = attachmentKind('', name)
  if (accepted === null) return null
  attachmentSequence += 1
  return { id: `a${attachmentSequence}`, kind: accepted.kind, name, source: 'path', path }
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

async function attachmentPath(attachment: Attachment): Promise<string> {
  if (attachment.source === 'path') return attachment.path
  return api.saveAttachment(await base64Of(attachment.file), attachment.extension)
}

function releasePreview(attachment: Attachment) {
  if (attachment.source === 'file' && attachment.preview !== null) URL.revokeObjectURL(attachment.preview)
}

/** Files dropped on the app window. The native webview takes drops itself and hands over paths. */
function useWindowDrop(onPaths: (paths: string[]) => void, enabled: boolean) {
  const handler = useRef(onPaths)
  handler.current = onPaths
  useEffect(() => {
    if (!native || !enabled) return
    let stopped = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === 'drop') handler.current(event.payload.paths)
        })
        .then((stop) => {
          if (stopped) stop()
          else unlisten = stop
        }),
    )
    return () => {
      stopped = true
      unlisten?.()
    }
  }, [enabled])
}

function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const preview = attachment.source === 'file' ? attachment.preview : null
  return (
    <li className="group relative flex h-14 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] pr-7 pl-1">
      {preview !== null ? (
        <img src={preview} alt={attachment.name} className="size-12 rounded-lg object-cover" />
      ) : (
        <span className="grid size-12 place-items-center rounded-lg bg-white/[0.06] text-[11px] font-semibold text-ink-300 uppercase">{attachment.kind === 'pdf' ? 'PDF' : 'IMG'}</span>
      )}
      <span title={attachment.name} className="max-w-36 truncate text-[12px] text-ink-300">{attachment.name}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.name}`}
        className="absolute top-1 right-1 grid size-5 place-items-center rounded-full text-[12px] text-ink-400 hover:bg-white/[0.1] hover:text-ink-100"
      >
        ×
      </button>
    </li>
  )
}

/** A dispatch chat's queue: read now, then every 2 seconds while anything waits; unqueue on Esc. */
function useChatQueue(dispatchId: string | undefined, sent: number): [QueueState, (action: QueueAction) => void] {
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

function QueuePills({ state, empty }: { state: QueueState; empty: boolean }) {
  if (state.pending.length === 0 && state.taking === null && state.hint === null) return null
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-1">
      {state.pending.map((item) => (
        <span key={item.id} title={item.text} className="flex max-w-64 items-center gap-1.5 rounded-full border border-accent/25 bg-accent/[0.08] px-2.5 py-0.5 text-[12px] text-ink-200">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
          <span className="truncate">{item.text}</span>
        </span>
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

/** Dictation into the composer: the transcript is written after what was already typed. */
function useDictation(read: () => string, write: (text: string) => void, onError: (message: string) => void) {
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
    const before = read().trimEnd()
    const prefix = before === '' ? '' : `${before} `
    const next = new Constructor()
    next.continuous = true
    next.interimResults = true
    next.lang = navigator.language
    next.onresult = (event) => {
      const spoken = Array.from(event.results, (result) => result[0].transcript).join('')
      write(prefix + spoken.trimStart())
    }
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

function SlashMenu({ commands, active, onPick, onHover }: { commands: SlashCommand[]; active: number; onPick: (command: SlashCommand) => void; onHover: (index: number) => void }) {
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <ul ref={list} role="listbox" className="absolute right-0 bottom-full left-0 mb-2 max-h-72 overflow-y-auto rounded-2xl border border-white/10 bg-ink-900/95 p-1.5 shadow-2xl backdrop-blur">
      {commands.map((command, index) => (
        <li key={`${command.source}:${command.name}`} role="option" aria-selected={index === active}>
          <button
            type="button"
            onMouseDown={(event) => {
              event.preventDefault()
              onPick(command)
            }}
            onMouseEnter={() => onHover(index)}
            className={`flex w-full items-baseline gap-2 rounded-xl px-3 py-1.5 text-left text-[13px] ${index === active ? 'bg-white/[0.1]' : ''}`}
          >
            <span className="shrink-0 font-mono font-semibold text-ink-100">/{command.name}</span>
            {command.argumentHint !== undefined && command.argumentHint !== null && <span className="shrink-0 font-mono text-[12px] text-ink-400">{command.argumentHint}</span>}
            <span className="min-w-0 flex-1 truncate text-ink-400">{command.description ?? ''}</span>
            <span className="shrink-0 text-[11px] text-ink-400 uppercase">{command.source}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * The message box both chat views share: rounded, pinned to the bottom of the window, growing with
 * its text up to about 40% of the height. Enter sends, Shift+Enter starts a new line; typing / at
 * the start lists the agent's slash commands.
 */
export function Composer({
  placeholder,
  disabled,
  agent,
  cwd,
  dispatchId,
  onSend,
}: {
  placeholder: string
  disabled: boolean
  agent: string | null
  cwd: string | null
  /** Set for megabrain chats: shows what still waits in the queue, and Esc takes it back. */
  dispatchId?: string
  /** Sends the message; resolves to the notice to show, and clears the box when the notice is ok. */
  onSend: (text: string) => Promise<Notice>
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [active, setActive] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const box = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const commands = useSlashCommands(agent, cwd)
  const textRef = useRef(text)
  textRef.current = text
  const dictation = useDictation(
    () => textRef.current,
    (value) => change(value),
    (message) => setNotice({ tone: 'bad', text: message }),
  )
  const [sentCount, setSentCount] = useState(0)
  const [queue, queueDispatch] = useChatQueue(dispatchId, sentCount)

  // A message taken back from the queue lands in the composer for editing.
  const restored = queue.restored
  useEffect(() => {
    if (restored === null) return
    setText(restored.text)
    box.current?.focus()
  }, [restored])

  const query = slashQuery(text)
  const matches = query === null || menuClosed ? [] : filterSlashCommands(commands, query)
  const menuOpen = matches.length > 0

  useLayoutEffect(() => {
    const element = box.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }, [text])

  const change = (value: string) => {
    setText(value)
    setActive(0)
    queueDispatch({ type: 'typed' })
    if (slashQuery(value) === null) setMenuClosed(false)
  }

  const pick = (command: SlashCommand) => {
    change(insertSlashCommand(command.name))
    box.current?.focus()
  }

  const attach = (added: (Attachment | null)[]) => {
    const accepted = added.filter((item): item is Attachment => item !== null)
    if (accepted.length < added.length) setNotice({ tone: 'bad', text: 'Only images and PDFs can be attached.' })
    if (accepted.length > 0) setAttachments((current) => [...current, ...accepted])
  }

  const remove = (id: string) =>
    setAttachments((current) => {
      const gone = current.find((item) => item.id === id)
      if (gone !== undefined) releasePreview(gone)
      return current.filter((item) => item.id !== id)
    })

  useWindowDrop((paths) => attach(paths.map(fromPath)), !disabled)

  // Object URLs for thumbnails live until the chip is removed or the composer goes away.
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  useEffect(() => () => attachmentsRef.current.forEach(releasePreview), [])

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return
    event.preventDefault()
    attach(files.map(fromFile))
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    event.preventDefault()
    attach(files.map(fromFile))
  }

  const send = () => {
    const message = text.trim()
    if ((message === '' && attachments.length === 0) || sending || disabled) return
    const sent = attachments
    setSending(true)
    setNotice(null)
    Promise.all(sent.map(attachmentPath))
      .then((paths) => onSend(appendAttachmentPaths(message, paths)))
      .then(
        (result) => {
          setNotice(result)
          setSentCount((count) => count + 1)
          if (result.tone === 'ok') {
            change('')
            sent.forEach(releasePreview)
            setAttachments((current) => current.filter((item) => !sent.includes(item)))
          }
        },
        (error: unknown) => setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setSending(false))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((current) => (current + step + matches.length) % matches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const command = matches[Math.min(active, matches.length - 1)]
        if (command !== undefined) {
          event.preventDefault()
          pick(command)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMenuClosed(true)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
      return
    }
    if (event.key === 'Escape' && dispatchId !== undefined) {
      event.preventDefault()
      queueDispatch({ type: 'escape', text })
    }
  }

  return (
    <footer className="shrink-0 px-6 pt-2 pb-4">
      {notice !== null && <p className={`mb-1.5 px-3 text-[12.5px] ${notice.tone === 'ok' ? 'text-ok' : 'text-bad'}`}>{notice.text}</p>}
      {dispatchId !== undefined && <QueuePills state={queue} empty={text.trim() === ''} />}
      <div className="relative">
        {menuOpen && <SlashMenu commands={matches} active={Math.min(active, matches.length - 1)} onPick={pick} onHover={setActive} />}
        <div
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault()
          }}
          onDrop={onDrop}
          className="rounded-2xl border border-white/15 bg-white/[0.05] p-2 focus-within:border-white/25"
        >
          {attachments.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <AttachmentChip key={attachment.id} attachment={attachment} onRemove={() => remove(attachment.id)} />
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => picker.current?.click()}
              disabled={disabled}
              aria-label="Attach images or PDFs"
              title="Attach images or PDFs"
              className="grid size-9 shrink-0 place-items-center rounded-xl text-ink-400 hover:bg-white/[0.08] hover:text-ink-100 disabled:opacity-40"
            >
              <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m21.4 11.6-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
              </svg>
            </button>
            <input
              ref={picker}
              type="file"
              accept="image/*,application/pdf"
              multiple
              hidden
              onChange={(event) => {
                attach(Array.from(event.target.files ?? []).map(fromFile))
                event.target.value = ''
              }}
            />
            <textarea
              ref={box}
              rows={1}
              value={text}
              onChange={(event) => change(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              disabled={disabled}
              placeholder={placeholder}
              aria-label="Message"
              className="max-h-[40vh] min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[14.5px] leading-6 text-ink-100 outline-none placeholder:text-ink-400"
            />
            {dictation.supported && (
              <button
                type="button"
                onClick={dictation.toggle}
                disabled={disabled}
                aria-pressed={dictation.listening}
                aria-label={dictation.listening ? 'Stop dictation' : 'Dictate'}
                title={dictation.listening ? 'Stop dictation' : 'Dictate'}
                className={`grid size-9 shrink-0 place-items-center rounded-xl disabled:opacity-40 ${dictation.listening ? 'bg-bad/[0.15] text-bad' : 'text-ink-400 hover:bg-white/[0.08] hover:text-ink-100'}`}
              >
                <svg viewBox="0 0 24 24" className={`size-[18px] ${dictation.listening ? 'animate-pulse' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </svg>
              </button>
            )}
            <button
              type="button"
              onClick={send}
              disabled={(text.trim() === '' && attachments.length === 0) || sending || disabled}
              aria-label="Send"
              className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent text-accent-ink disabled:opacity-40"
            >
              {sending ? <Spinner /> : '↑'}
            </button>
          </div>
        </div>
      </div>
    </footer>
  )
}
