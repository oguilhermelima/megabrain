import type { TranscriptImage } from '@/api/schema'

/** A run of the message's text, or a row of its images by index into the event's images. */
export type UserSegment = { kind: 'text'; text: string } | { kind: 'images'; images: number[] }

const marker = /\[Image #\d+\]/g

/**
 * Where each image of a sent message goes. The text keeps an [Image #N] marker where each image was;
 * N counts across the whole session, so the k-th marker takes the k-th image. Markers with only
 * whitespace between them share a row, images beyond the markers go in a row above the text, and a
 * marker with no image left stays as text.
 */
export function placeImages(text: string, images: readonly TranscriptImage[] | undefined): UserSegment[] {
  const count = images?.length ?? 0
  const segments: UserSegment[] = []
  let used = 0
  let from = 0
  for (const match of text.matchAll(marker)) {
    if (used === count) break
    const before = text.slice(from, match.index)
    const last = segments.at(-1)
    if (last?.kind === 'images' && before.trim() === '') last.images.push(used)
    else {
      if (before.trim() !== '') segments.push({ kind: 'text', text: before })
      segments.push({ kind: 'images', images: [used] })
    }
    used += 1
    from = match.index + match[0].length
  }
  const rest = text.slice(from)
  if (rest.trim() !== '' || segments.length === 0) segments.push({ kind: 'text', text: rest })
  if (used < count) segments.unshift({ kind: 'images', images: Array.from({ length: count - used }, (_, offset) => used + offset) })
  return segments
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
