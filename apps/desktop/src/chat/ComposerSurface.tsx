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

export function ComposerSurface({ dispatchId, dispatchQueue, sendable, above, queue, editing, onEdit, menu, banner, send, onDismiss, box, frame, editor, placeholder, empty, disabled, onInput, onFocus, onKeyDown, onPaste, onContextMenu, onClick, onPointerDown, onPointerMove, onPointerLeave, onDragOver, onDragLeave, onDrop, onDragEnd, dropCaret, toolbar }: {
  dispatchId?: string
  dispatchQueue: QueueState
  sendable: boolean
  above?: ReactNode
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
    <>
      <div className="px-3">
        {dispatchId !== undefined && <QueuePills state={dispatchQueue} empty={!sendable} />}
        {above}
        {queue !== undefined && <QueueStrip queue={queue} editing={editing} onEdit={(item) => onEdit(item.id)} />}
      </div>
      <div className="relative">
        {menu.shown !== null && <CommandMenu anchor={menu.shown.anchor} label="Commands" sections={menu.shown.sections} active={menu.shown.active} query={menu.shown.query} status={menu.shown.status} width={Math.min(720, menu.shown.anchor.right - menu.shown.anchor.left)} inside={menu.box} leaving={menu.leaving} onActive={menu.setActive} onPick={menu.pick} onClose={menu.close} />}
        {banner !== null && <NoticeBanner banner={banner} onRetry={send} onDismiss={onDismiss} />}
        {/* Docked: the pane's full width, set apart by a hairline on top. */}
        <div ref={box} className="border-t border-white/[0.06] bg-ink-900">
          <div ref={frame} className="relative min-w-0 px-4 pt-3">
            {empty && <span className="pointer-events-none absolute top-3 right-4 left-4 truncate text-[14.5px] leading-6 text-ink-400">{placeholder}</span>}
            <div ref={editor} role="textbox" aria-multiline="true" aria-label="Message" aria-disabled={disabled} aria-placeholder={placeholder} contentEditable={disabled ? false : 'plaintext-only'} onInput={onInput} onFocus={onFocus} onKeyDown={onKeyDown} onPaste={onPaste} onContextMenu={onContextMenu} onClick={onClick} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} onDragStart={(event) => event.preventDefault()} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onDragEnd={onDragEnd} className="max-h-[40vh] min-h-12 overflow-y-auto text-[14.5px] leading-6 break-words whitespace-pre-wrap text-ink-100 outline-none" />
            {dropCaret !== null && <span className="pointer-events-none absolute w-0.5 rounded-full bg-accent" style={{ left: dropCaret.left - 1, top: dropCaret.top, height: dropCaret.height }} />}
          </div>
          <ComposerToolbar {...toolbar} />
        </div>
      </div>
    </>
  )
}
