import { describe, expect, test } from 'bun:test'
import { transcriptEventSchema, type MessagePart } from '@/api/schema'
import { imageLabel, imageName, thumbnail, userMarkdown } from '@/chat/user-images'

const a = { path: '/var/folders/x1/T/orca-paste-1.png' }
const b = { path: '/Users/operator/Desktop/shot.jpg' }
const c = { dataUrl: 'data:image/png;base64,AAAA' }

const slot = (index: number) => `<span data-image="${index}"></span>`
const slots = (markdown: string) => markdown.match(/<span data-image="\d+"><\/span>/g)?.length ?? 0

describe('userMarkdown', () => {
  test('text without images is the text as it came', () => {
    expect(userMarkdown('hello', undefined)).toBe('hello')
    expect(userMarkdown('hello', [])).toBe('hello')
  })

  test('recorded parts put each image inline where the composer placed it', () => {
    const parts: MessagePart[] = [{ type: 'image', path: a.path }, { type: 'text', text: 'teste' }, { type: 'image', path: b.path }]
    expect(userMarkdown('teste', [a, b], parts)).toBe(`${slot(0)}teste${slot(1)}`)
  })

  test('an image sent once shows once, before the echo and after a reload', () => {
    const parts: MessagePart[] = [{ type: 'image', path: a.path }, { type: 'text', text: 'teste novmaente' }]
    expect(slots(userMarkdown('teste novmaente', [a], parts))).toBe(1)
    const reloaded = transcriptEventSchema.parse(JSON.parse(JSON.stringify({ id: 'u1', at: null, kind: 'user', text: 'teste novmaente', images: [a], parts })))
    expect(slots(userMarkdown(reloaded.text, reloaded.images, reloaded.parts))).toBe(1)
  })

  test('without parts or markers the images go before the text, in their own paragraph', () => {
    expect(userMarkdown('what changed?', [a, c])).toBe(`${slot(0)}${slot(1)}\n\nwhat changed?`)
  })

  test('each marker takes the next image in order, whatever its number', () => {
    expect(userMarkdown('look [Image #54] then [Image #55] done', [a, b])).toBe(`look ${slot(0)} then ${slot(1)} done`)
  })

  test('images beyond the markers go before the text', () => {
    expect(userMarkdown('see [Image #3]', [a, b, c])).toBe(`${slot(1)}${slot(2)}\n\nsee ${slot(0)}`)
  })

  test('a marker with no image left stays as text', () => {
    expect(userMarkdown('[Image #1] and [Image #2]', [a])).toBe(`${slot(0)} and [Image #2]`)
  })

  test('a message of only images is only its chips', () => {
    expect(userMarkdown('[Image #9]', [a])).toBe(slot(0))
    expect(userMarkdown('', [a], [{ type: 'image', path: a.path }])).toBe(slot(0))
  })
})

describe('imageLabel', () => {
  test('images are numbered within their message, as the composer labels them', () => {
    expect(imageLabel(0)).toBe('Image 1')
    expect(imageLabel(2)).toBe('Image 3')
  })
})

describe('imageName', () => {
  test('a path is named by its file', () => {
    expect(imageName(a, 0)).toBe('orca-paste-1.png')
  })

  test('an inline image is named by its position', () => {
    expect(imageName(c, 2)).toBe('Image 3')
  })
})

describe('thumbnail', () => {
  const asset = (path: string) => `asset://localhost${path}`

  test('a path loads through the asset protocol', () => {
    expect(thumbnail(a, 0, { toAsset: asset, failed: false })).toEqual({ kind: 'image', src: 'asset://localhost/var/folders/x1/T/orca-paste-1.png', name: 'orca-paste-1.png' })
  })

  test('an inline image uses its data URL', () => {
    expect(thumbnail(c, 0, { toAsset: asset, failed: false })).toEqual({ kind: 'image', src: 'data:image/png;base64,AAAA', name: 'Image 1' })
  })

  test('a file that failed to load is a placeholder with its name', () => {
    expect(thumbnail(b, 1, { toAsset: asset, failed: true })).toEqual({ kind: 'placeholder', name: 'shot.jpg' })
  })

  test('a path with no asset protocol, as in the browser preview, is a placeholder', () => {
    expect(thumbnail(b, 1, { toAsset: null, failed: false })).toEqual({ kind: 'placeholder', name: 'shot.jpg' })
  })
})
