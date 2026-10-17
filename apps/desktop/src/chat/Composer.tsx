import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MutableRefObject, type ReactNode } from 'react'
import type { MessagePart, SlashCommand } from '@/api/schema'
import { ContextMenu } from '@/components/ContextMenu'
import { usePresence } from '@/lib/usePresence'
import type { AnchorRect } from '@/advanced/menu-placement'
import { insertSlashCommand, skillInvocation } from '@/chat/composer-model'
import { commandSections } from '@/chat/command-menu'
import { useSlashCommands, draftSlashQuery, menuNotice } from '@/chat/ComposerSlashCommands'
import { useRecentCommands } from '@/chat/CommandMenu'
import { deleteRange, draftLength, draftText, insertText, messagePartsFromText, tokenIds, type Draft } from '@/chat/composer-parts'
import { useComposerModel } from '@/chat/ComposerModel'
import { composerBanner, sendState, type Notice } from '@/chat/composer-look'
import { Lightbox, type LightboxImage } from '@/chat/Lightbox'
import { ComposerSurface } from '@/chat/ComposerSurface'
import { readDraft, relabel, renderDraft, selectionOffsets, setCaret, type TokenView } from '@/chat/rich-input'
import { insertBlock } from '@/chat/chat-menu-model'
import type { ComposeChannel } from '@/chat/chat-menu'
import type { QueueControls } from '@/chat/QueueStrip'
import { ChipPreview, fromFile, useChatQueue, type Attachment } from '@/chat/ComposerSupport'
import { useComposerSend } from '@/chat/ComposerSend'
import { useAttachmentInteractions } from '@/chat/ComposerAttachmentInteractions'
import { useComposerClipboard } from '@/chat/ComposerClipboard'
import { useComposerKeyboard } from '@/chat/ComposerKeyboard'
import { useComposerAttachmentDrop } from '@/chat/ComposerAttachmentDrop'
import { useComposerQueueEditing } from '@/chat/ComposerQueueEditing'
import { useComposerDictation } from '@/chat/ComposerDictation'

export type { Notice } from '@/chat/composer-look'

/**
 * The message box both chat views share: docked across the pane's bottom edge, growing with
 * its text up to about 40% of the height. Images and PDFs sit inside the text as labelled chips where
 * they were pasted, dropped or picked; hovering an image's chip shows it, and a chip can be dragged to
 * another place. Enter sends, Shift+Enter
 * starts a new line; typing / at the start lists the agent's slash commands.
 */
export function Composer({
  placeholder,
  disabled,
  agent,
  cwd,
  dispatchId,
  context,
  model = null,
  onModelChange,
  onSend,
  running = false,
  onStop,
  fill = null,
  channel,
  initCommands,
  queue,
  above,
  sendDraft,
}: {
  /** Text to put in the box, replacing the draft; a new object each time, as a suggestion is picked. */
  fill?: { text: string } | null
  placeholder: string
  disabled: boolean
  agent: string | null
  cwd: string | null
  /** Set for megabrain chats: shows what still waits in the queue, and Esc takes it back. */
  dispatchId?: string
  /** The chat's context when known: tokens used and the model's window. */
  context?: { tokens?: number | null; window?: number | null }
  /** The chat's model when known. */
  model?: string | null
  /** Set for native chats, which switch model and effort themselves; without it, picking a model sends /model <model> through onSend. */
  onModelChange?: (model: string, effort: string | undefined) => Promise<void>
  /** Sends the message as text and image parts in order; resolves to the notice to show (null: sent, nothing to say), and clears the box unless it is bad. */
  onSend: (parts: MessagePart[]) => Promise<Notice | null>
  /** The agent's turn runs: with nothing typed, the send button stops it through onStop. */
  running?: boolean
  onStop?: () => void
  /** Where the transcript's right-click menu puts quotes and code; the box fills it while it takes text. */
  channel?: ComposeChannel
  /** The command names the running agent reported (Claude's init), merged into the discovered list. */
  initCommands?: readonly string[]
  /** Set for native chats: the messages waiting for the turn to end, shown above the box to edit, reorder, remove or send now. */
  queue?: QueueControls
  /** Shown above the queue and the box, inside the composer's gutter: a native chat's artifacts row. */
  above?: ReactNode
  /** Filled with the box's send while it is mounted, so the view can send the draft that waits in it. */
  sendDraft?: MutableRefObject<(() => void) | null>
}) {
  const [draft, setDraft] = useState<Draft>([])
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  // Whether the notice reports a send that failed, which the banner offers to retry.
  const [failedSend, setFailedSend] = useState(false)
  const show = (next: Notice | null, fromSend = false) => {
    setNotice(next)
    setFailedSend(fromSend)
  }
  const [active, setActive] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const [dropCaret, setDropCaret] = useState<{ left: number; top: number; height: number } | null>(null)
  const [preview, setPreview] = useState<{ images: LightboxImage[]; start: number } | null>(null)
  const [skillAnchor, setSkillAnchor] = useState<AnchorRect | null>(null)
  const [hover, setHover] = useState<{ id: string; left: number; top: number } | null>(null)
  const editor = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  // Every attachment added since the last send, by token id. Kept when a token is deleted, so an
  // undo that brings the token back still finds it; released when the message goes or the box closes.
  const attachments = useRef(new Map<string, Attachment>())
  // The last selection inside the box, for what the buttons insert while focus is on them.
  const caret = useRef<[number, number]>([0, 0])
  const commandList = useSlashCommands(agent, cwd, initCommands)
  const commands = commandList.commands
  const [recent, rememberCommand] = useRecentCommands(agent)
  const [sentCount, setSentCount] = useState(0)
  const [dispatchQueue, queueDispatch] = useChatQueue(dispatchId, sentCount)

  const kindOf = (id: string) => attachments.current.get(id)?.kind ?? 'image'

  const view = (id: string): TokenView => {
    const attachment = attachments.current.get(id)
    return attachment === undefined ? { kind: 'image', name: 'missing' } : { kind: attachment.kind, name: attachment.name }
  }

  /** The draft as the box holds it right now; state can trail the DOM by a render. */
  const current = (): Draft => (editor.current === null ? draft : readDraft(editor.current))

  const changed = (next: Draft) => {
    if (editor.current !== null) relabel(editor.current, next, kindOf)
    setDraft(next)
    setActive(0)
    queueDispatch({ type: 'typed' })
    if (draftSlashQuery(next) === null) setMenuClosed(false)
  }

  /** Shows a draft the composer built itself and puts the caret at `offset`. */
  const apply = (next: Draft, offset: number) => {
    const element = editor.current
    if (element !== null) {
      renderDraft(element, next, view)
      element.focus()
      setCaret(element, offset)
    }
    caret.current = [offset, offset]
    changed(next)
  }

  const { editing, setEditing, load, clear, editQueued, cancelEdit } = useComposerQueueEditing({
    queue,
    draft,
    attachments: attachments.current,
    apply,
    show,
  })

  const selection = (): [number, number] => (editor.current === null ? null : selectionOffsets(editor.current)) ?? caret.current

  useEffect(() => {
    if (fill !== null) apply(insertText([], 0, fill.text), fill.text.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill])

  const insertAt = (text: string, [start, end]: [number, number] = selection()) => apply(insertText(deleteRange(current(), start, end), start, text), start + text.length)

  // Assigned on every render so the transcript always calls the latest draft's insert.
  useEffect(() => {
    if (channel === undefined || disabled) return
    channel.current = (block) => {
      const at = selection()
      insertAt(insertBlock(draftText(current()).slice(0, at[0]), block), at)
    }
    return () => {
      channel.current = null
    }
  })

  useEffect(() => {
    const onSelection = () => {
      const element = editor.current
      const offsets = element === null ? null : selectionOffsets(element)
      if (offsets !== null) caret.current = offsets
    }
    document.addEventListener('selectionchange', onSelection)
    return () => document.removeEventListener('selectionchange', onSelection)
  }, [])

  const dictation = useComposerDictation({ current, selection, apply, show })

  // A message taken back from the queue lands in the composer for editing, its image paths as tokens.
  const restored = dispatchQueue.restored
  useEffect(() => {
    if (restored === null) return
    load(messagePartsFromText(restored.text))
    // Only a newly restored message runs this; apply reads the latest refs.
  }, [restored])

  // The slash menu opens while the message is a command word being typed; a second slash means a path.
  const query = draftSlashQuery(draft)
  // It opens before the list arrives, saying it loads, failed or that the agent has none, rather than staying shut.
  const menuOpen = query !== null && !menuClosed && agent !== null && !query.includes('/')
  const sections = menuOpen ? commandSections(commands, query, recent) : []
  const menuStatus = menuOpen && agent !== null ? menuNotice(commandList, agent) : null
  const matches = sections.flatMap((section) => section.items)
  const activeMatch = Math.min(active, Math.max(0, matches.length - 1))
  // Measured once as it opens: a command word never wraps, so the box keeps its size while it is typed.
  const [menuAnchor, setMenuAnchor] = useState<AnchorRect | null>(null)
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuAnchor(null)
      return
    }
    const rect = box.current?.getBoundingClientRect()
    if (rect !== undefined) setMenuAnchor((open) => open ?? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
  }, [menuOpen])
  const closeMenu = useCallback(() => setMenuClosed(true), [])
  // A closing menu fades with what it last listed.
  // Typing / after a failed or empty answer asks again; the menu says it loads meanwhile.
  const { status: commandStatus, refresh: refreshCommands } = commandList
  const retryOnOpen = menuOpen && (commandStatus === 'error' || (commandStatus === 'ready' && commandList.commands.length === 0))
  useEffect(() => {
    if (retryOnOpen) refreshCommands()
    // Only the menu opening retries; the answer landing must not ask again.
  }, [menuOpen])
  const slashMenu = usePresence(menuOpen && menuAnchor !== null && query !== null ? { anchor: menuAnchor, sections, active: activeMatch, query, status: menuStatus } : null)

  const pick = (command: SlashCommand) => {
    rememberCommand(command)
    const text = insertSlashCommand(command.name)
    apply([{ type: 'text', text }], text.length)
  }

  const attach = useComposerAttachmentDrop({
    editor,
    disabled,
    attachments: attachments.current,
    current,
    selection,
    apply,
    show,
  })

  const { onPaste, onContextMenu, contextMenu } = useComposerClipboard({
    editor,
    picker,
    disabled,
    current,
    selection,
    apply,
    insertAt,
    attach,
    show,
  })

  const { onClick, onPointerDown, onHover, onDragOver, onDragLeave, onDrop, removeToken } = useAttachmentInteractions({
    editor,
    frame,
    disabled,
    current,
    apply,
    attach,
    attachments: attachments.current,
    hover,
    setHover,
    setPreview,
    setDropCaret,
  })

  const closePreview = useCallback(() => setPreview(null), [])
  const closeSkills = useCallback(() => setSkillAnchor(null), [])
  const skillMenu = usePresence(skillAnchor)
  const hasSkills = commands.some((command) => command.source === 'skill' || command.source === 'plugin')

  /** A picked skill goes in at the caret, apart from a word right before it. */
  const pickSkill = (command: SlashCommand) => {
    setSkillAnchor(null)
    rememberCommand(command)
    const at = caret.current
    const before = draftText(current()).slice(0, at[0])
    const text = skillInvocation(agent ?? '', command.name)
    insertAt(before === '' || /\s$/.test(before) ? text : ` ${text}`, at)
  }

  const { shownModel, shownEffort, shownContext, pickModel } = useComposerModel({
    agent,
    model,
    context,
    onModelChange,
    onSend,
    show,
    onSent: () => setSentCount((count) => count + 1),
  })

  const sendable = draft.some((part) => part.type === 'token') || draftText(draft).trim() !== ''

  const send = useComposerSend({
    current,
    attachments,
    sending,
    setSending,
    disabled,
    show,
    editing,
    setEditing,
    queue,
    onSend,
    clear,
    onSent: () => setSentCount((count) => count + 1),
  })

  useEffect(() => {
    if (sendDraft === undefined) return
    sendDraft.current = send
    return () => {
      sendDraft.current = null
    }
  })

  /** The browser edited the box in place; a chip it brought back while that chip was already there is taken out again. */
  const onInput = (event: FormEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const next = readDraft(element)
    if (element.querySelectorAll('[data-token]').length > tokenIds(next).length) apply(next, Math.min(selection()[1], draftLength(next)))
    else changed(next)
  }

  const onKeyDown = useComposerKeyboard({
    menuOpen,
    matches,
    activeMatch,
    setActive,
    pick,
    closeMenu,
    insertAt,
    send,
    selection,
    current,
    removeToken,
    queue,
    editing,
    clear,
    setEditing,
    load,
    cancelEdit,
    dispatchId,
    queueDispatch,
  })

  const button = sendState({ sendable, sending, disabled, running: running && onStop !== undefined })
  const banner = composerBanner(notice, { failedSend, sendable })

  return (
    // A container, so the controls fit the pane's width rather than the window's.
    <footer className="@container/composer shrink-0 pt-2">
      {preview !== null && <Lightbox images={preview.images} start={preview.start} onClose={closePreview} />}
      {hover !== null && <ChipPreview attachment={attachments.current.get(hover.id)} left={hover.left} top={hover.top} />}
      <ComposerSurface
        dispatchId={dispatchId}
        dispatchQueue={dispatchQueue}
        sendable={sendable}
        above={above}
        queue={queue}
        editing={editing}
        onEdit={editQueued}
        menu={{ shown: slashMenu.shown, leaving: slashMenu.leaving, box, setActive, pick, close: closeMenu }}
        banner={banner}
        send={send}
        onDismiss={() => show(null)}
        box={box}
        frame={frame}
        editor={editor}
        placeholder={placeholder}
        empty={draft.length === 0}
        disabled={disabled}
        onInput={onInput}
        onFocus={refreshCommands}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onContextMenu={onContextMenu}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onHover}
        onPointerLeave={() => setHover(null)}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onDragEnd={() => setDropCaret(null)}
        dropCaret={dropCaret}
        toolbar={{ picker, disabled, agent, hasSkills, skillAnchor, setSkillAnchor, skillMenu, commands, recent: [...recent], pickSkill, closeSkills, shownContext, shownModel, shownEffort, canSetEffort: onModelChange !== undefined, pickModel, dictation, button, onStop, send, onAttachFiles: (files) => attach(files.map(fromFile)) }}
      />
      <ContextMenu menu={contextMenu.menu} onClose={contextMenu.close} />
    </footer>
  )
}
