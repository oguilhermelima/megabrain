import type { ComponentProps, Dispatch, DragEventHandler, FormEventHandler, ClipboardEventHandler, KeyboardEventHandler, MouseEventHandler, PointerEventHandler, RefObject, ReactNode, SetStateAction } from 'react'
import type { SlashCommand } from '@/api/schema'
import { CommandMenu } from '@/chat/CommandMenu'
import type { MenuSection } from '@/chat/command-menu'
import type { AnchorRect } from '@/advanced/menu-placement'
import type { Banner } from '@/chat/composer-look'
import { NoticeBanner, QueuePills } from '@/chat/ComposerSupport'
import { QueueStrip, type QueueControls } from '@/chat/QueueStrip'
import { ComposerToolbar } from '@/chat/ComposerToolbar'
import type { QueueState } from '@/chat/queue-model'
import type { MenuNotice } from '@/chat/slash-commands'
import { pageX } from '@/lib/page'

/** The box's text inset inside the card (px-4), where the placeholder sits too. */
const boxInset = 16

export function ComposerSurface({ dispatchId, dispatchQueue, sendable, above, edge, queue, editing, onEdit, menu, banner, send, onDismiss, box, frame, editor, placeholder, empty, disabled, onInput, onFocus, onKeyDown, onPaste, onContextMenu, onClick, onPointerDown, onPointerMove, onPointerLeave, onDragOver, onDragLeave, onDrop, onDragEnd, dropCaret, toolbar }: {
  dispatchId?: string
  dispatchQueue: QueueState
  sendable: boolean
  above?: ReactNode
  edge?: ReactNode
  queue?: QueueControls
  editing: string | null
  onEdit: (id: string) => void
  menu: { shown: { anchor: AnchorRect; sections: MenuSection[]; active: number; query: string; status: MenuNotice | null } | null; leaving: boolean; box: RefObject<HTMLDivElement | null>; setActive: Dispatch<SetStateAction<number>>; pick: (command: SlashCommand) => void; close: () => void }
  banner: Banner | null
  send: () => void
  onDismiss: () => void
  box: RefObject<HTMLDivElement | null>
  frame: RefObject<HTMLDivElement | null>
  editor: RefObject<HTMLDivElement | null>
  placeholder: string
  empty: boolean
  disabled: boolean
  onInput: FormEventHandler<HTMLDivElement>
  onFocus: () => void
  onKeyDown: KeyboardEventHandler<HTMLDivElement>
  onPaste: ClipboardEventHandler<HTMLDivElement>
  onContextMenu: MouseEventHandler<HTMLDivElement>
  onClick: MouseEventHandler<HTMLDivElement>
  onPointerDown: PointerEventHandler<HTMLDivElement>
  onPointerMove: PointerEventHandler<HTMLDivElement>
  onPointerLeave: () => void
  onDragOver: DragEventHandler<HTMLDivElement>
  onDragLeave: DragEventHandler<HTMLDivElement>
  onDrop: DragEventHandler<HTMLDivElement>
  onDragEnd: () => void
  dropCaret: { left: number; top: number; height: number } | null
  toolbar: ComponentProps<typeof ComposerToolbar>
}) {
  return (
    // One card on the pane's bottom edge: what waits to go out, the chat's state rows, the box and its toolbar.
    <div className={`${pageX} pb-4`}>
      <div className="relative">
        {menu.shown !== null && <CommandMenu anchor={menu.shown.anchor} label="Commands" sections={menu.shown.sections} active={menu.shown.active} query={menu.shown.query} status={menu.shown.status} width={Math.min(720, menu.shown.anchor.right - menu.shown.anchor.left)} inside={menu.box} leaving={menu.leaving} onActive={menu.setActive} onPick={menu.pick} onClose={menu.close} />}
        <div ref={box} className="overflow-hidden rounded-card border border-white/[0.09] bg-ink-900 shadow-[0_12px_32px_-12px_rgb(0_0_0/0.8)] transition-colors duration-100 focus-within:border-white/[0.15] motion-reduce:transition-none">
          {/* What waits to go out and the chat's chips; gone, with its hairline, when none of them shows. */}
          <div className="border-b border-white/[0.06] px-3 pt-2.5 pb-1 empty:hidden">
            {dispatchId !== undefined && <QueuePills state={dispatchQueue} empty={!sendable} />}
            {above}
            {queue !== undefined && <QueueStrip queue={queue} editing={editing} onEdit={(item) => onEdit(item.id)} />}
          </div>
          {banner !== null ? <NoticeBanner banner={banner} onRetry={send} onDismiss={onDismiss} /> : edge}
          <div ref={frame} className="relative min-w-0 px-4 pt-3">
            {empty && <span style={{ left: boxInset, right: boxInset }} className="pointer-events-none absolute top-3 truncate text-chat text-ink-400">{placeholder}</span>}
            <div ref={editor} role="textbox" aria-multiline="true" aria-label="Message" aria-disabled={disabled} aria-placeholder={placeholder} contentEditable={disabled ? false : 'plaintext-only'} onInput={onInput} onFocus={onFocus} onKeyDown={onKeyDown} onPaste={onPaste} onContextMenu={onContextMenu} onClick={onClick} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} onDragStart={(event) => event.preventDefault()} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onDragEnd={onDragEnd} className="max-h-[40vh] min-h-12 overflow-y-auto text-chat break-words whitespace-pre-wrap text-ink-100 outline-none" />
            {dropCaret !== null && <span className="pointer-events-none absolute w-0.5 rounded-full bg-accent" style={{ left: dropCaret.left - 1, top: dropCaret.top, height: dropCaret.height }} />}
          </div>
          <ComposerToolbar {...toolbar} />
        </div>
      </div>
    </div>
  )
}
