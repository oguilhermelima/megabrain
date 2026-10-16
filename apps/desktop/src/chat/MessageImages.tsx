import { convertFileSrc } from '@tauri-apps/api/core'
import { useMemo, useState } from 'react'
import type { TranscriptImage } from '@/api/schema'
import { Lightbox } from '@/chat/Lightbox'
import { markMenu } from '@/chat/chat-menu'
import { MarkdownText } from '@/chat/markdown'
import { placeImages, thumbnail, type Thumbnail } from '@/chat/user-images'
import { native } from '@/lib/surface'

const toAsset = native ? convertFileSrc : null

/** A sent message: its text as markdown, with its images as thumbnails where the text placed them. */
export function UserMessageBody({ text, images }: { text: string; images: readonly TranscriptImage[] | undefined }) {
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set())
  const [open, setOpen] = useState<number | null>(null)
  const segments = useMemo(() => placeImages(text, images), [text, images])
  const thumbs: Thumbnail[] = useMemo(() => (images ?? []).map((image, index) => thumbnail(image, index, { toAsset, failed: failed.has(index) })), [images, failed])
  // The preview steps through the images that loaded, in the message's order.
  const viewable = thumbs.flatMap((thumb, index) => (thumb.kind === 'image' ? [{ index, src: thumb.src, name: thumb.name }] : []))
  const start = viewable.findIndex((item) => item.index === open)

  return (
    <div className="space-y-2 [overflow-wrap:anywhere]">
      {segments.map((segment, position) =>
        segment.kind === 'text' ? (
          <MarkdownText key={position} text={segment.text} />
        ) : (
          <div key={position} className="flex flex-wrap gap-2">
            {segment.images.map((index) => {
              const thumb = thumbs[index]
              if (thumb === undefined) return null
              return thumb.kind === 'image' ? (
                <button
                  key={index}
                  type="button"
                  onClick={() => setOpen(index)}
                  onContextMenu={(event) => markMenu(event, { image: { src: thumb.src, name: thumb.name, open: () => setOpen(index) } })}
                  aria-label={`Open ${thumb.name}`}
                  title={thumb.name}
                  className="block overflow-hidden rounded-[12px] border border-white/[0.1] hover:border-white/25 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <img src={thumb.src} alt={thumb.name} onError={() => setFailed((previous) => new Set(previous).add(index))} className="block h-auto max-h-[240px] w-auto max-w-[240px] object-contain" />
                </button>
              ) : (
                <span key={index} title={thumb.name} className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.05] px-2.5 py-1 text-[12px] text-ink-300">
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="12" height="10" rx="2" />
                    <path d="m2.5 11 3.5-3.5 3 3 2-2 2.5 2.5" />
                  </svg>
                  <span className="truncate">{thumb.name}</span>
                </span>
              )
            })}
          </div>
        ),
      )}
      {start >= 0 && <Lightbox images={viewable} start={start} onClose={() => setOpen(null)} />}
    </div>
  )
}
