import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { api } from '@/api'
import type { MessagePart, SlashCommand } from '@/api/schema'
import { ContextMenu, useContextMenu } from '@/components/ContextMenu'
import { Spinner } from '@/components/ui'
import type { MenuIcon } from '@/components/menu-icons'
import { usePresence } from '@/lib/usePresence'
import { insideModal, useWindowDrop } from '@/lib/window-drop'
import type { AnchorRect } from '@/advanced/menu-placement'
import { insertSlashCommand, skillInvocation, slashQuery } from '@/chat/composer-model'
import { commandSections } from '@/chat/command-menu'
import { createCommandSource, menuNotice, mergeInitCommands, type CommandList } from '@/chat/slash-commands'
import { CommandMenu, handleMenuKey, useRecentCommands } from '@/chat/CommandMenu'
import { deleteRange, draftLength, draftText, insertText, insertToken, messagePartsFromText, moveToken, tokenAfter, tokenBefore, tokenIds, tokenOffset, toMessageParts, type Draft } from '@/chat/composer-parts'
import { sessionCommand, withContextWindow } from '@/chat/composer-status'
import { ComposerStatus, type ModelPick } from '@/chat/ComposerStatus'
import { composerBanner, sendState, switchNotice, type Notice } from '@/chat/composer-look'
import { Lightbox, type LightboxImage } from '@/chat/Lightbox'
import { SkillMenu } from '@/chat/SkillMenu'
import { caretRect, offsetAtPoint, readDraft, relabel, renderDraft, selectionOffsets, setCaret, tokenAt, type TokenView } from '@/chat/rich-input'
import { composerMenu, insertBlock, type ComposerAction } from '@/chat/chat-menu-model'
import { toSections, type ComposeChannel } from '@/chat/chat-menu'
import { QueueStrip, type QueueControls } from '@/chat/QueueStrip'
import { reconcileWalk, walkKey } from '@/chat/queue-walk'
import { attachmentPath, ChipPreview, fromFile, fromPath, NoticeBanner, QueuePills, releasePreview, useChatQueue, useDictation, previewOf, type Attachment } from '@/chat/ComposerSupport'

export type { Notice } from '@/chat/composer-look'

// Slash commands per agent and folder for the whole app run, read as the composer mounts.
const commandSource = createCommandSource((agent, cwd) => api.slashCommands(agent, cwd))
// What a queued message's edit answers when chatd had already sent the message.
const TAKEN = Symbol('taken')

/**
 * The agent's slash commands for this folder, loaded as soon as both are known rather than from a
 * chat event, so a chat that never sent a message lists them too. `refresh` asks again: on focus,
 * and when / is typed after a failed or empty answer.
 */
function useSlashCommands(agent: string | null, cwd: string | null, initNames: readonly string[] | undefined): CommandList & { refresh: () => void } {
  const [list, setList] = useState<CommandList>(() => ({ status: 'idle', commands: agent !== null && cwd !== null ? (commandSource.peek(agent, cwd) ?? []) : [], error: null }))
  // Only the latest call writes the list, so a slow answer for another agent or folder never lands here.
  const latest = useRef(0)
  const asked = useRef(0)
  const run = useCallback(
    (refresh: boolean) => {
      latest.current += 1
      const call = latest.current
      if (agent === null || agent === '' || cwd === null || cwd === '') {
        setList({ status: 'idle', commands: [], error: null })
        return
      }
      setList({ status: 'loading', commands: commandSource.peek(agent, cwd) ?? [], error: null })
      commandSource.load(agent, cwd, { refresh }).then(
        (commands) => {
          if (latest.current === call) setList({ status: 'ready', commands, error: null })
        },
        (error: unknown) => {
          if (latest.current === call) setList({ status: 'error', commands: commandSource.peek(agent, cwd) ?? [], error: error instanceof Error ? error.message : String(error) })
        },
      )
    },
    [agent, cwd],
  )
  useEffect(() => {
    asked.current = Date.now()
    run(false)
    return () => {
      latest.current += 1
    }
  }, [run])
  // Focus comes often (every pick puts it back), so a good list is asked again at most every half minute.
  const refresh = useCallback(() => {
    const now = Date.now()
    if (list.status === 'loading' || (list.status === 'ready' && list.commands.length > 0 && now - asked.current < 30_000)) return
    asked.current = now
    run(true)
  }, [run, list.status, list.commands.length])
  const commands = mergeInitCommands(list.commands, initNames)
  return { ...list, commands, refresh }
}

/** A draft's slash-command query: only a message of plain text can start with a command. */
function draftSlashQuery(draft: Draft): string | null {
  return draft.some((part) => part.type === 'token') ? null : slashQuery(draftText(draft))
}

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
  // The queued message the box holds for editing: Enter saves it, and the queue moves it to its end; Esc gives it back unchanged.
  const [editing, setEditing] = useState<string | null>(null)
  const queueItems = queue?.items
  useEffect(() => {
    setEditing((current) => reconcileWalk({ editing: current }, queueItems?.map((item) => item.id) ?? []).editing)
  }, [queueItems])

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

  // Dictation writes at the caret where it started, replacing what it wrote before as it hears more.
  const dictationBase = useRef<{ draft: Draft; offset: number } | null>(null)
  const dictation = useDictation(
    () => {
      dictationBase.current = { draft: current(), offset: selection()[1] }
    },
    (spoken) => {
      const base = dictationBase.current
      if (base === null) return
      const before = draftText(base.draft).slice(0, base.offset)
      const words = spoken.trimStart()
      const text = before === '' || /\s$/.test(before) ? words : ` ${words}`
      apply(insertText(base.draft, base.offset, text), base.offset + text.length)
    },
    (message) => show({ tone: 'bad', text: message }),
  )

  /** Puts a message's parts in the box, its image paths as tokens, with the caret at the end. */
  const load = (parts: readonly MessagePart[]) => {
    const next = parts.flatMap((part): Draft => {
      if (part.type === 'text') return [part]
      const attachment = fromPath(part.path)
      if (attachment === null) return [{ type: 'text', text: part.path }]
      attachments.current.set(attachment.id, attachment)
      return [{ type: 'token', id: attachment.id }]
    })
    apply(next, draftLength(next))
  }

  /** Empties the box and lets go of its attachments. */
  const clear = () => {
    apply([], 0)
    attachments.current.forEach(releasePreview)
    attachments.current.clear()
  }

  // A message taken back from the queue lands in the composer for editing, its image paths as tokens.
  const restored = dispatchQueue.restored
  useEffect(() => {
    if (restored === null) return
    load(messagePartsFromText(restored.text))
    // Only a newly restored message runs this; apply reads the latest refs.
  }, [restored])

  /** Takes a queued message into the box to edit; whatever was being edited is given back unchanged. */
  const editQueued = (id: string) => {
    const item = queue?.items.find((candidate) => candidate.id === id)
    if (item === undefined) return
    if (editing === null && sendable) {
      show({ tone: 'bad', text: 'Send or clear the message in the box before editing a queued one.' })
      return
    }
    clear()
    setEditing(id)
    load(item.parts)
  }

  /** Leaves the edit: the queued message stays as it was. */
  const cancelEdit = () => {
    setEditing(null)
    clear()
  }

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

  /** Puts attachments into the text where the caret or the drop is, one token each. */
  const attach = (added: (Attachment | null)[], [start, end]: [number, number] = selection()) => {
    const accepted = added.filter((item): item is Attachment => item !== null)
    if (accepted.length < added.length) show({ tone: 'bad', text: 'Only images and PDFs can be attached.' })
    if (accepted.length === 0) return
    let next = deleteRange(current(), start, end)
    let offset = start
    for (const attachment of accepted) {
      attachments.current.set(attachment.id, attachment)
      next = insertToken(next, offset, attachment.id)
      offset += 1
    }
    apply(next, offset)
  }

  useWindowDrop(
    {
      onDrop: (paths, x, y) => {
        // A drop on an open dialog (Import project takes folders) is the dialog's, not the chat's.
        if (insideModal(x, y)) return
        const at = editor.current === null ? null : offsetAtPoint(editor.current, x, y)
        attach(paths.map(fromPath), at === null ? undefined : [at, at])
      },
    },
    !disabled,
  )

  useEffect(
    () => () => {
      attachments.current.forEach(releasePreview)
    },
    [],
  )

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    const files = Array.from(event.clipboardData.files)
    if (files.length > 0) {
      attach(files.map(fromFile))
      return
    }
    const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
    if (text !== '') insertAt(text)
  }

  // The box's own right-click menu: it covers cut, copy, paste and select all, so it replaces the
  // webview's. Paste reads the clipboard natively, as the webview's would ask before each read.
  const contextMenu = useContextMenu()
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const element = editor.current
    if (element === null) return
    const range = selection()
    const selected = window.getSelection()
    const text = selected !== null && !selected.isCollapsed && element.contains(selected.anchorNode) ? selected.toString() : ''
    const failed = (caught: unknown) => show({ tone: 'bad', text: caught instanceof Error ? caught.message : String(caught) })
    const pasteText = () => api.pasteText().catch(() => '')
    const run = (action: ComposerAction) => {
      switch (action) {
        case 'cut':
          api.copyText(text).then(() => apply(deleteRange(current(), range[0], range[1]), range[0]), failed)
          return
        case 'copy':
          api.copyText(text).catch(failed)
          return
        case 'paste':
          // Text first, as the box takes it; an image only when the clipboard has no text.
          pasteText()
            .then(async (pasted) => {
              if (pasted !== '') return insertAt(pasted.replace(/\r\n?/g, '\n'), range)
              const image = await api.pasteImage()
              if (image !== null) attach([fromFile(image)], range)
            })
            .catch(failed)
          return
        case 'paste-plain':
          pasteText().then((pasted) => {
            if (pasted !== '') insertAt(pasted.replace(/\r\n?/g, '\n'), range)
          }, failed)
          return
        case 'select-all': {
          element.focus()
          const all = document.createRange()
          all.selectNodeContents(element)
          selected?.removeAllRanges()
          selected?.addRange(all)
          return
        }
        case 'attach':
          picker.current?.click()
          return
        case 'clear':
          apply([], 0)
      }
    }
    const icons: Record<ComposerAction, MenuIcon> = {
      cut: 'cut',
      copy: 'copy',
      paste: 'paste',
      'paste-plain': 'paste',
      'select-all': 'select',
      attach: 'attach',
      clear: 'close',
    }
    contextMenu.open(event, toSections(composerMenu({ hasSelection: text !== '', empty: current().length === 0, disabled }), run, icons))
  }

  const removeToken = (id: string) => {
    setHover(null)
    const draftNow = current()
    const offset = tokenOffset(draftNow, id)
    if (offset !== null) apply(deleteRange(draftNow, offset, offset + 1), offset)
  }

  // A chip moves with pointer events rather than a native drag: in the app's webview a native drag
  // is taken by the window's own file drop, so it never reached the box as a move.
  const drag = useRef<{ id: string; x: number; y: number; moving: boolean } | null>(null)
  const justDragged = useRef(false)

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (justDragged.current) return
    const element = editor.current
    const token = element === null ? null : tokenAt(event.target, element)
    const id = token?.dataset.token
    if (id === undefined) return
    if (event.target instanceof HTMLElement && event.target.closest('[data-remove]') !== null) {
      removeToken(id)
      return
    }
    // The message's images in order, opened at the one clicked.
    const images = tokenIds(current()).flatMap((tokenId) => {
      const attachment = attachments.current.get(tokenId)
      const src = attachment === undefined ? null : previewOf(attachment)
      return attachment === undefined || src === null ? [] : [{ id: tokenId, src, name: attachment.name }]
    })
    const start = images.findIndex((image) => image.id === id)
    if (start >= 0) setPreview({ images, start })
  }

  const showDropCaret = (offset: number | null) => {
    const element = editor.current
    const box = frame.current
    const rect = element === null || offset === null ? null : caretRect(element, offset)
    if (rect === null || box === null) {
      setDropCaret(null)
      return
    }
    const origin = box.getBoundingClientRect()
    setDropCaret({ left: rect.left - origin.left, top: rect.top - origin.top, height: rect.height })
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const element = editor.current
    if (event.button !== 0 || disabled || element === null || !(event.target instanceof HTMLElement) || event.target.closest('[data-remove]') !== null) return
    const id = tokenAt(event.target, element)?.dataset.token
    if (id === undefined) return
    // No caret, selection or native drag starts from a chip.
    event.preventDefault()
    drag.current = { id, x: event.clientX, y: event.clientY, moving: false }
  }

  const dragging = (id: string, on: boolean) => {
    const chip = editor.current?.querySelector<HTMLElement>(`[data-token="${id}"]`)
    if (chip === null || chip === undefined) return
    if (on) chip.dataset.dragging = ''
    else delete chip.dataset.dragging
  }

  const pointer = useRef({ move: (_event: globalThis.PointerEvent) => {}, end: (_event: globalThis.PointerEvent | null) => {} })
  pointer.current.move = (event) => {
    const state = drag.current
    if (state === null) return
    if (!state.moving) {
      if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < 4) return
      state.moving = true
      setHover(null)
      dragging(state.id, true)
    }
    showDropCaret(editor.current === null ? null : offsetAtPoint(editor.current, event.clientX, event.clientY))
  }
  pointer.current.end = (event) => {
    const state = drag.current
    drag.current = null
    if (state === null || !state.moving) return
    dragging(state.id, false)
    setDropCaret(null)
    // The click that ends a drag does not open the image.
    justDragged.current = true
    setTimeout(() => {
      justDragged.current = false
    }, 0)
    const element = editor.current
    const at = event === null || element === null ? null : offsetAtPoint(element, event.clientX, event.clientY)
    if (at === null) return
    const next = moveToken(current(), state.id, at)
    apply(next, (tokenOffset(next, state.id) ?? 0) + 1)
  }
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => pointer.current.move(event)
    const up = (event: globalThis.PointerEvent) => pointer.current.end(event)
    const cancel = () => pointer.current.end(null)
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || drag.current?.moving !== true) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  /** The image under the pointer shows above its chip. */
  const onHover = (event: PointerEvent<HTMLDivElement>) => {
    const element = editor.current
    const chip = element === null || drag.current !== null ? null : tokenAt(event.target, element)
    const id = chip?.dataset.token
    if (chip === null || chip === undefined || id === undefined) {
      if (hover !== null) setHover(null)
      return
    }
    if (hover?.id === id) return
    const box = chip.getBoundingClientRect()
    setHover({ id, left: box.left, top: box.top })
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    showDropCaret(editor.current === null ? null : offsetAtPoint(editor.current, event.clientX, event.clientY))
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!(event.relatedTarget instanceof Node) || frame.current?.contains(event.relatedTarget) !== true) setDropCaret(null)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDropCaret(null)
    const element = editor.current
    const at = element === null ? null : offsetAtPoint(element, event.clientX, event.clientY)
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    event.preventDefault()
    attach(files.map(fromFile), at === null ? undefined : [at, at])
  }

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

  // The last switch made here: the effort, which the chat record does not carry, and for a session
  // switched by command the model, shown until the session reports a model of its own.
  const [chosen, setChosen] = useState<{ model: string; effort: string | undefined; base: string | null; byCommand: boolean } | null>(null)
  const sameModel = (left: string, right: string) => withContextWindow(left, 'standard') === withContextWindow(right, 'standard')
  const overridden = chosen !== null && chosen.byCommand && chosen.base === model
  const shownModel = overridden ? chosen.model : model
  const shownEffort = chosen !== null && shownModel !== null && sameModel(chosen.model, shownModel) ? chosen.effort : undefined
  // The session's own window belongs to the model it reported, not to one switched to since.
  const shownContext = overridden ? { tokens: context?.tokens, window: null } : context

  const pickModel = ({ model: picked, window, effort }: ModelPick) => {
    if (onModelChange !== undefined) {
      onModelChange(picked, effort).then(
        () => setChosen({ model: picked, effort, base: model, byCommand: false }),
        (error: unknown) => show({ tone: 'bad', text: error instanceof Error ? error.message : String(error) }),
      )
      return
    }
    // Only the agent itself switches a session it runs: /model, or /effort when only the effort
    // changes, goes as a message of its own, through the same path as a reply, and leaves the draft alone.
    const command = sessionCommand(agent, shownModel, { model: picked, window, effort })
    if (command === null) return
    onSend([{ type: 'text', text: command }]).then(
      (result) => {
        const ok = result === null || result.tone === 'ok'
        if (ok) setChosen({ model: picked, effort, base: model, byCommand: picked !== model })
        show(switchNotice(result))
        setSentCount((count) => count + 1)
      },
      (error: unknown) => show({ tone: 'bad', text: error instanceof Error ? error.message : String(error) }),
    )
  }

  const sendable = draft.some((part) => part.type === 'token') || draftText(draft).trim() !== ''

  const send = () => {
    const message = current().filter((part) => part.type === 'text' || attachments.current.has(part.id))
    const ids = tokenIds(message)
    if ((ids.length === 0 && draftText(message).trim() === '') || sending || disabled) return
    setSending(true)
    show(null)
    Promise.all(
      ids.map(async (id) => {
        const attachment = attachments.current.get(id)
        if (attachment === undefined) throw new Error('An attachment went missing; attach it again.')
        return [id, { kind: attachment.kind, path: await attachmentPath(attachment) }] as const
      }),
    )
      .then((saved): Promise<Notice | typeof TAKEN | null> => {
        const paths = new Map(saved)
        const parts = toMessageParts(message, (id) => {
          const found = paths.get(id)
          if (found === undefined) throw new Error('An attachment went missing; attach it again.')
          return found
        })
        // An edited queued message is saved in place of being sent; the queue moves it to its end.
        const edited = editing === null ? undefined : queue?.items.find((item) => item.id === editing)
        if (edited !== undefined && queue !== undefined) return queue.edit(edited.id, parts).then((outcome) => (outcome === 'taken' ? TAKEN : null))
        return onSend(parts)
      })
      .then(
        (result) => {
          // The message was sent before the edit landed: the box keeps the edited text as a plain draft.
          if (result === TAKEN) {
            setEditing(null)
            show({ tone: 'ok', text: 'Already sent; your edit is in the composer.' })
            return
          }
          const bad = result?.tone === 'bad'
          show(result, bad)
          setSentCount((count) => count + 1)
          if (!bad) {
            setEditing(null)
            clear()
          }
        },
        (error: unknown) => show({ tone: 'bad', text: error instanceof Error ? error.message : String(error) }, true),
      )
      .finally(() => setSending(false))
  }

  /** The browser edited the box in place; a chip it brought back while that chip was already there is taken out again. */
  const onInput = (event: FormEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const next = readDraft(element)
    if (element.querySelectorAll('[data-token]').length > tokenIds(next).length) apply(next, Math.min(selection()[1], draftLength(next)))
    else changed(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return
    if (
      menuOpen &&
      handleMenuKey(event, matches.length, activeMatch, {
        move: setActive,
        pick: () => {
          const item = matches[activeMatch]
          if (item !== undefined) pick(item.command)
        },
        close: closeMenu,
      })
    )
      return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) insertAt('\n')
      else send()
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const [start, end] = selection()
      const draftNow = current()
      const id = start !== end ? null : event.key === 'Backspace' ? tokenBefore(draftNow, start) : tokenAfter(draftNow, start)
      if (id !== null) {
        event.preventDefault()
        removeToken(id)
      }
      return
    }
    // The arrows walk the queue from an empty box, and Esc leaves the message being edited; Enter saves through send.
    if (queue !== undefined && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Escape') && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
      const draftNow = current()
      const [start, end] = selection()
      const length = draftLength(draftNow)
      const step = walkKey({ editing }, event.key, {
        ids: queue.items.map((item) => item.id),
        empty: draftNow.length === 0 || (tokenIds(draftNow).length === 0 && draftText(draftNow).trim() === ''),
        atStart: start === 0 && end === 0,
        atEnd: start === length && end === length,
      })
      if (step.handled) {
        event.preventDefault()
        const effect = step.effect
        if (effect?.type === 'load') {
          const item = queue.items.find((candidate) => candidate.id === effect.id)
          if (item !== undefined) {
            clear()
            setEditing(item.id)
            load(item.parts)
          }
        } else if (effect?.type === 'clear') cancelEdit()
        return
      }
    }
    if (event.key === 'Escape' && dispatchId !== undefined) {
      event.preventDefault()
      queueDispatch({ type: 'escape', text: draftText(current()) })
    }
  }

  const ghost =
    'grid size-8 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.07] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'
  const button = sendState({ sendable, sending, disabled, running: running && onStop !== undefined })
  const banner = composerBanner(notice, { failedSend, sendable })

  return (
    // A container, so the controls fit the pane's width rather than the window's.
    <footer className="@container/composer shrink-0 pt-2">
      {preview !== null && <Lightbox images={preview.images} start={preview.start} onClose={closePreview} />}
      {hover !== null && <ChipPreview attachment={attachments.current.get(hover.id)} left={hover.left} top={hover.top} />}
      {/* The rows above the box start where its text does. */}
      <div className="px-3">
        {dispatchId !== undefined && <QueuePills state={dispatchQueue} empty={!sendable} />}
        {above}
        {queue !== undefined && <QueueStrip queue={queue} editing={editing} onEdit={(item) => editQueued(item.id)} />}
      </div>
      <div className="relative">
        {slashMenu.shown !== null && (
          <CommandMenu
            anchor={slashMenu.shown.anchor}
            label="Commands"
            sections={slashMenu.shown.sections}
            active={slashMenu.shown.active}
            query={slashMenu.shown.query}
            status={slashMenu.shown.status}
            width={Math.min(720, slashMenu.shown.anchor.right - slashMenu.shown.anchor.left)}
            inside={box}
            leaving={slashMenu.leaving}
            onActive={setActive}
            onPick={pick}
            onClose={closeMenu}
          />
        )}
        {banner !== null && <NoticeBanner banner={banner} onRetry={send} onDismiss={() => show(null)} />}
        {/* Docked: the pane's full width, set apart by a hairline on top. */}
        <div ref={box} className="border-t border-white/[0.06] bg-ink-900">
          <div ref={frame} className="relative min-w-0 px-4 pt-3">
            {draft.length === 0 && <span className="pointer-events-none absolute top-3 right-4 left-4 truncate text-[14.5px] leading-6 text-ink-400">{placeholder}</span>}
            <div
              ref={editor}
              role="textbox"
              aria-multiline="true"
              aria-label="Message"
              aria-disabled={disabled}
              aria-placeholder={placeholder}
              contentEditable={disabled ? false : 'plaintext-only'}
              onInput={onInput}
              onFocus={refreshCommands}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onContextMenu={onContextMenu}
              onClick={onClick}
              onPointerDown={onPointerDown}
              onPointerMove={onHover}
              onPointerLeave={() => setHover(null)}
              onDragStart={(event) => event.preventDefault()}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onDragEnd={() => setDropCaret(null)}
              className="max-h-[40vh] min-h-12 overflow-y-auto text-[14.5px] leading-6 break-words whitespace-pre-wrap text-ink-100 outline-none"
            />
            {dropCaret !== null && <span className="pointer-events-none absolute w-0.5 rounded-full bg-accent" style={{ left: dropCaret.left - 1, top: dropCaret.top, height: dropCaret.height }} />}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 px-2.5 pt-1.5 pb-2.5">
            <button type="button" onClick={() => picker.current?.click()} disabled={disabled} aria-label="Attach images or PDFs" title="Attach images or PDFs" className={ghost}>
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m21.4 11.6-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
              </svg>
            </button>
            {/* The tooltip sits on a wrapper: a disabled button gets no pointer events to show one. */}
            <span title={hasSkills ? 'Use a skill' : `${agent ?? 'This agent'} has no skills here`} className="shrink-0">
              <button
                type="button"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  setSkillAnchor((open) => (open === null ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null))
                }}
                onMouseDown={(event) => {
                  // Keeps the caret in the box and lets a second click close the open menu.
                  event.preventDefault()
                  event.stopPropagation()
                }}
                disabled={disabled || !hasSkills}
                aria-label="Skills"
                aria-expanded={skillAnchor !== null}
                className={`${ghost} aria-expanded:bg-white/[0.08] aria-expanded:text-ink-100`}
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
                  <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
                  <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
                  <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
                </svg>
              </button>
            </span>
            {skillMenu.shown !== null && <SkillMenu anchor={skillMenu.shown} commands={commands} recent={recent} leaving={skillMenu.leaving} onPick={pickSkill} onClose={closeSkills} />}
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
            <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-white/[0.08]" />
            <ComposerStatus agent={agent} context={shownContext} model={shownModel} effort={shownEffort} canSetEffort={onModelChange !== undefined} onPickModel={pickModel} />
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {dictation.supported && (
                <button
                  type="button"
                  onClick={dictation.toggle}
                  disabled={disabled}
                  aria-pressed={dictation.listening}
                  aria-label={dictation.listening ? 'Stop dictation' : 'Dictate'}
                  title={dictation.listening ? 'Stop dictation' : 'Dictate'}
                  className={dictation.listening ? `${ghost} bg-bad/[0.15] text-bad hover:bg-bad/[0.2] hover:text-bad` : ghost}
                >
                  <svg viewBox="0 0 24 24" className={`size-4 ${dictation.listening ? 'animate-pulse motion-reduce:animate-none' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="9" y="3" width="6" height="11" rx="3" />
                    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={button === 'stop' ? onStop : send}
                disabled={button !== 'ready' && button !== 'stop'}
                aria-label={button === 'sending' ? 'Sending' : button === 'stop' ? 'Stop' : 'Send'}
                aria-busy={button === 'sending'}
                title={button === 'ready' ? 'Send (Enter)' : button === 'stop' ? 'Stop the turn (Esc)' : undefined}
                className={`grid size-8 shrink-0 place-items-center rounded-full transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none ${
                  button === 'ready' || button === 'stop' ? 'bg-accent text-accent-ink hover:bg-accent/90' : button === 'sending' ? 'bg-white/[0.1] text-ink-200' : 'bg-white/[0.07] text-ink-500'
                }`}
              >
                {button === 'sending' ? (
                  <Spinner />
                ) : button === 'stop' ? (
                  <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden="true">
                    <rect x="2" y="2" width="12" height="12" rx="2.5" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
      <ContextMenu menu={contextMenu.menu} onClose={contextMenu.close} />
    </footer>
  )
}
