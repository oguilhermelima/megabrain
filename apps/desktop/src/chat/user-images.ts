import type { MessagePart, TranscriptImage } from '@/api/schema'

const marker = /\[Image #\d+\]/g

/** Where an image's chip goes in a message's markdown; MessageImages renders the span as the chip. */
export function imageSlot(index: number): string {
  return `<span data-image="${index}"></span>`
}

/** An image's chip label: numbered within its message, as the composer labels its chips. */
export function imageLabel(index: number): string {
  return `Image ${index + 1}`
}

/**
 * A sent message as markdown with a slot for each image's chip. A native chat's event records its parts in order,
 * so the k-th image part takes the k-th image where the composer placed it. An imported message keeps an
 * [Image #N] marker where each image was instead; N counts across the whole session, so the k-th marker takes the
 * k-th image, and a marker with no image left stays as text. Images with no place go before the text, in a
 * paragraph of their own.
 */
export function userMarkdown(text: string, images: readonly TranscriptImage[] | undefined, parts?: readonly MessagePart[]): string {
  const count = images?.length ?? 0
  if (count === 0) return text
  let used = 0
  let body = ''
  if (parts !== undefined && parts.some((part) => part.type === 'image')) {
    for (const part of parts) {
      if (part.type === 'text') body += part.text
      else if (used < count) body += imageSlot(used++)
    }
  } else {
    body = text.replace(marker, (found) => (used < count ? imageSlot(used++) : found))
  }
  if (used === count) return body
  const leading = Array.from({ length: count - used }, (_, offset) => imageSlot(used + offset)).join('')
  return body.trim() === '' ? leading : `${leading}\n\n${body}`
}

export function imageName(image: TranscriptImage, index: number): string {
  return 'path' in image ? (image.path.split('/').at(-1) ?? image.path) : `Image ${index + 1}`
}

export type Thumbnail = { kind: 'image'; src: string; name: string } | { kind: 'placeholder'; name: string }

/**
 * What a thumbnail shows: a local file through the asset protocol, an inline image as it came, or a
 * chip with the name when the file did not load or there is no asset protocol (the browser preview).
 */
export function thumbnail(image: TranscriptImage, index: number, { toAsset, failed }: { toAsset: ((path: string) => string) | null; failed: boolean }): Thumbnail {
  const name = imageName(image, index)
  if (failed) return { kind: 'placeholder', name }
  if ('path' in image) return toAsset === null ? { kind: 'placeholder', name } : { kind: 'image', src: toAsset(image.path), name }
  return image.dataUrl.startsWith('data:image/') ? { kind: 'image', src: image.dataUrl, name } : { kind: 'placeholder', name }
}
