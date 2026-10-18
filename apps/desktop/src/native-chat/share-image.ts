import type { ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'

// A message shared as an image: the card is rendered with the app's own components off screen, then
// drawn by modern-screenshot, which serialises the DOM with its computed styles into an SVG
// foreignObject and paints that on a canvas. The app's fonts are system fonts, so no font is fetched
// or embedded (font: false). Loaded on first use, so the library stays out of the app's first bundle.

/** The card `content` renders as PNG bytes, at least at 2x so text stays sharp on a Retina screen. */
export async function renderPng(content: ReactNode): Promise<Uint8Array> {
  const host = document.createElement('div')
  // Off screen, not hidden: the clone keeps the card's own styles, never the host's.
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none'
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(content))
    const card = host.firstElementChild
    if (!(card instanceof HTMLElement)) throw new Error('Could not draw the message.')
    await document.fonts.ready
    await Promise.all(
      [...card.querySelectorAll('img')].map((image) =>
        image.complete
          ? null
          : new Promise((resolve) => {
              image.addEventListener('load', resolve, { once: true })
              image.addEventListener('error', resolve, { once: true })
            }),
      ),
    )
    const { domToBlob } = await import('modern-screenshot')
    const blob = await domToBlob(card, { scale: Math.max(2, window.devicePixelRatio), type: 'image/png', font: false })
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    root.unmount()
    host.remove()
  }
}
