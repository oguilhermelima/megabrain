import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MessagePart, TranscriptImage } from '@/api/schema'
import { Lightbox } from '@/chat/Lightbox'
import { markMenu } from '@/chat/chat-menu'
import { MarkdownText } from '@/chat/markdown'
import { chipClass } from '@/chat/rich-input'
import { imageLabel, thumbnail, userMarkdown, type Thumbnail } from '@/chat/user-images'
import { native } from '@/lib/surface'

const toAsset = native ? convertFileSrc : null

// The pointer rests this long on a chip before its picture shows, so passing over one shows nothing.
const previewDelayMs = 300
const previewSize = 320

/** The picture of a chip the pointer rests on, above it, or below it when there is no room above. */
function ChipPreview({ src, name, anchor }: { src: string; name: string; anchor: DOMRect }) {
  const above = anchor.top > previewSize + 40
  return createPortal(
    <div style={{ left: anchor.left, top: above ? anchor.top - 6 : anchor.bottom + 6 }} className={`popover pointer-events-none fixed z-[100] p-1 ${above ? '-translate-y-full' : ''}`}>
      <img src={src} alt={name} className="block max-h-80 max-w-80 rounded-lg object-contain" />
    </div>,
    document.body,
  )
}

/** An image of a sent message as the composer showed it: a chip with its label; hover shows it, a click opens it. */
function ImageChip({ thumb, label, onOpen, onFailed }: { thumb: Thumbnail; label: string; onOpen: () => void; onFailed: () => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (thumb.kind === 'placeholder') {
    return (
      <span title={thumb.name} className={`${chipClass} px-1.5 text-ink-400`}>
        {label}
      </span>
    )
  }
  const show = (element: HTMLElement) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setAnchor(element.getBoundingClientRect()), previewDelayMs)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setAnchor(null)
  }
  return (
    <button
      type="button"
      onClick={() => {
        hide()
        onOpen()
      }}
      onPointerEnter={(event) => show(event.currentTarget)}
      onPointerLeave={hide}
      onFocus={(event) => show(event.currentTarget)}
      onBlur={hide}
      onContextMenu={(event) => markMenu(event, { image: { src: thumb.src, name: thumb.name, open: onOpen } })}
      aria-label={`Open ${label}`}
      className={`${chipClass} cursor-pointer px-1.5 focus-visible:outline-2 focus-visible:outline-accent`}
    >
      {label}
      {/* Loaded out of sight, so a file that is gone turns the chip into its placeholder before anyone hovers it. */}
      <img src={thumb.src} alt="" onError={onFailed} className="hidden" />
      {anchor !== null && <ChipPreview src={thumb.src} name={thumb.name} anchor={anchor} />}
    </button>
  )
}

/** A sent message: its text as markdown, with each image as a chip where the composer placed it. */
export function UserMessageBody({ text, images, parts }: { text: string; images: readonly TranscriptImage[] | undefined; parts?: readonly MessagePart[] }) {
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set())
  const [open, setOpen] = useState<number | null>(null)
  const markdown = useMemo(() => userMarkdown(text, images, parts), [text, images, parts])
  const thumbs: Thumbnail[] = useMemo(() => (images ?? []).map((image, index) => thumbnail(image, index, { toAsset, failed: failed.has(index) })), [images, failed])
  // The preview steps through the images that loaded, in the message's order.
  const viewable = thumbs.flatMap((thumb, index) => (thumb.kind === 'image' ? [{ index, src: thumb.src, name: thumb.name }] : []))
  const start = viewable.findIndex((item) => item.index === open)

  const chip = (index: number) => {
    const thumb = thumbs[index]
    if (thumb === undefined) return null
    return <ImageChip key={index} thumb={thumb} label={imageLabel(index)} onOpen={() => setOpen(index)} onFailed={() => setFailed((previous) => new Set(previous).add(index))} />
  }

  return (
    <div className="[overflow-wrap:anywhere]">
      <MarkdownText text={markdown} image={chip} />
      {start >= 0 && <Lightbox images={viewable} start={start} onClose={() => setOpen(null)} />}
    </div>
  )
}
