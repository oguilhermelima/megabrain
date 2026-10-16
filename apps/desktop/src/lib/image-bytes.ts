// Images as bytes for the clipboard and the save dialog. The clipboard takes PNG only, so any other
// format is redrawn on a canvas; the image is fetched first, which keeps an asset-protocol image from
// tainting the canvas the way drawing the <img> itself would.

/** Bytes as base64, in chunks so a large image does not overflow the argument list. */
export function base64Of(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  return btoa(binary)
}

async function canvasPng(draw: (context: CanvasRenderingContext2D) => void, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Could not draw the image.')
  draw(context)
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob === null ? reject(new Error('Could not encode the image.')) : resolve(blob)), 'image/png'))
}

/** RGBA pixels, as the native clipboard reads them, as a PNG file the composer can attach. */
export async function pngFile(rgba: Uint8Array, width: number, height: number, name: string): Promise<File> {
  const pixels = new ImageData(new Uint8ClampedArray(rgba), width, height)
  const blob = await canvasPng((context) => context.putImageData(pixels, 0, 0), width, height)
  return new File([blob], name, { type: 'image/png' })
}

/** An image's bytes as stored, with its type, for saving it as it is. */
export async function imageBytes(src: string): Promise<{ bytes: Uint8Array; type: string }> {
  const response = await fetch(src)
  if (!response.ok) throw new Error('Could not read the image.')
  const blob = await response.blob()
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type }
}

/** An image as PNG bytes, converted when it is stored in another format. */
export async function pngBytes(src: string): Promise<Uint8Array> {
  const response = await fetch(src)
  if (!response.ok) throw new Error('Could not read the image.')
  const blob = await response.blob()
  if (blob.type === 'image/png') return new Uint8Array(await blob.arrayBuffer())
  const bitmap = await createImageBitmap(blob)
  const png = await canvasPng((context) => context.drawImage(bitmap, 0, 0), bitmap.width, bitmap.height)
  bitmap.close()
  return new Uint8Array(await png.arrayBuffer())
}

const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** A file name for saving, with the extension the image's type calls for. */
export function saveName(name: string, type: string): string {
  const extension = extensions[type]
  if (extension === undefined || name.toLowerCase().endsWith(`.${extension}`) || (extension === 'jpg' && /\.jpe?g$/i.test(name))) return name
  return `${name.replace(/\.[a-z0-9]+$/i, '')}.${extension}`
}
