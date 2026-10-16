import { describe, expect, test } from 'bun:test'
import { imageName, placeImages, thumbnail } from '@/chat/user-images'

const a = { path: '/var/folders/x1/T/orca-paste-1.png' }
const b = { path: '/Users/operator/Desktop/shot.jpg' }
const c = { dataUrl: 'data:image/png;base64,AAAA' }

describe('placeImages', () => {
  test('text without images is one text segment', () => {
    expect(placeImages('hello', undefined)).toEqual([{ kind: 'text', text: 'hello' }])
    expect(placeImages('hello', [])).toEqual([{ kind: 'text', text: 'hello' }])
  })

  test('each marker takes the next image in order, whatever its number', () => {
    expect(placeImages('look [Image #54] then [Image #55] done', [a, b])).toEqual([
      { kind: 'text', text: 'look ' },
      { kind: 'images', images: [0] },
      { kind: 'text', text: ' then ' },
      { kind: 'images', images: [1] },
      { kind: 'text', text: ' done' },
    ])
  })

  test('markers separated only by whitespace share one row', () => {
    expect(placeImages('[Image #1]\n[Image #2]\nwhat changed?', [a, b])).toEqual([
      { kind: 'images', images: [0, 1] },
      { kind: 'text', text: '\nwhat changed?' },
    ])
  })

  test('without markers the images go in a row above the text', () => {
    expect(placeImages('what changed?', [a, c])).toEqual([
      { kind: 'images', images: [0, 1] },
      { kind: 'text', text: 'what changed?' },
    ])
  })

  test('images beyond the markers go in the row above', () => {
    expect(placeImages('see [Image #3]', [a, b, c])).toEqual([
      { kind: 'images', images: [1, 2] },
      { kind: 'text', text: 'see ' },
      { kind: 'images', images: [0] },
    ])
  })

  test('a marker with no image left stays as text', () => {
    expect(placeImages('[Image #1] and [Image #2]', [a])).toEqual([
      { kind: 'images', images: [0] },
      { kind: 'text', text: ' and [Image #2]' },
    ])
  })

  test('a message of only images has no text segment', () => {
    expect(placeImages('[Image #9]', [a])).toEqual([{ kind: 'images', images: [0] }])
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
