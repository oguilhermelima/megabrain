import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export interface LightboxImage {
  src: string
  name: string
}

/**
 * An image over the whole window, fit to it, with its name. Escape or a click outside closes it;
 * the left and right arrows step through the other images of the same message.
 */
export function Lightbox({ images, start, onClose }: { images: LightboxImage[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start)
  const count = images.length
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft' && count > 1) setIndex((current) => (current - 1 + count) % count)
      else if (event.key === 'ArrowRight' && count > 1) setIndex((current) => (current + 1) % count)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    // Capture, so Escape closes the preview before the composer treats it as taking a message back.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [count, onClose])
  const image = images[Math.min(index, count - 1)]
  if (image === undefined) return null
  const step = (by: number) => setIndex((current) => (current + by + count) % count)
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.name}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="fixed inset-0 z-[110] flex flex-col items-center justify-center gap-3 bg-ink-950/85 p-10 backdrop-blur-sm"
    >
      <img src={image.src} alt={image.name} className="min-h-0 max-w-full flex-1 rounded-xl object-contain" />
      <p className="shrink-0 text-[13px] text-ink-300">
        {image.name}
        {count > 1 && <span className="ml-2 text-ink-400">{`${index + 1} / ${count}`}</span>}
      </p>
      {count > 1 && (
        <>
          <button type="button" onClick={() => step(-1)} aria-label="Previous image" className="absolute top-1/2 left-4 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/[0.08] text-[20px] text-ink-100 hover:bg-white/[0.15]">
            ‹
          </button>
          <button type="button" onClick={() => step(1)} aria-label="Next image" className="absolute top-1/2 right-4 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/[0.08] text-[20px] text-ink-100 hover:bg-white/[0.15]">
            ›
          </button>
        </>
      )}
      <button type="button" onClick={onClose} aria-label="Close preview" className="absolute top-4 right-4 grid size-9 place-items-center rounded-full bg-white/[0.08] text-[16px] text-ink-100 hover:bg-white/[0.15]">
        ×
      </button>
    </div>,
    document.body,
  )
}
