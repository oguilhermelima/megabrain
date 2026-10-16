import { describe, expect, test } from 'bun:test'
import { compareByDisplayName, customPicture, displayName, isHexColor, nameEdit, pictureUrl, projectTint, tintSwatches } from '@/advanced/appearance-model'

const project = (appearance?: { name?: string; color?: string; picture?: string }) => ({ name: 'canto', path: '/w/canto', ...(appearance === undefined ? {} : { appearance }) })

describe('displayName', () => {
  test('the real name without a custom one', () => {
    expect(displayName(project())).toBe('canto')
    expect(displayName(project({}))).toBe('canto')
  })

  test('the custom name when set, trimmed', () => {
    expect(displayName(project({ name: '  Canto TV ' }))).toBe('Canto TV')
  })

  test('a blank custom name falls back to the real one', () => {
    expect(displayName(project({ name: '   ' }))).toBe('canto')
  })
})

describe('nameEdit', () => {
  test('a typed name is saved trimmed', () => {
    expect(nameEdit(project(), ' Canto ')).toBe('Canto')
  })

  test('clearing the field, or typing the real name, returns to the real name', () => {
    expect(nameEdit(project({ name: 'Canto' }), '')).toBeNull()
    expect(nameEdit(project({ name: 'Canto' }), '   ')).toBeNull()
    expect(nameEdit(project({ name: 'Canto' }), 'canto')).toBeNull()
  })
})

describe('projectTint', () => {
  test('none without a colour', () => {
    expect(projectTint(project())).toBeNull()
  })

  test('a #rrggbb colour is the tint', () => {
    expect(projectTint(project({ color: '#12abEF' }))).toBe('#12abEF')
  })

  test('anything else is ignored rather than handed to CSS', () => {
    for (const color of ['red', '#fff', '#12345', '#1234567', 'url(x)', '#12345g', '']) expect(projectTint(project({ color }))).toBeNull()
  })

  test('the palette offers ten valid, distinct swatches', () => {
    expect(tintSwatches.length).toBe(10)
    expect(new Set(tintSwatches.map((swatch) => swatch.toLowerCase())).size).toBe(10)
    expect(tintSwatches.every(isHexColor)).toBe(true)
  })
})

describe('customPicture', () => {
  test('null without one, so the detected picture shows', () => {
    expect(customPicture(project())).toBeNull()
    expect(customPicture(project({ picture: '' }))).toBeNull()
  })

  test('the stored path when set', () => {
    expect(customPicture(project({ picture: '/h/.megabrain/project-pictures/ab.png' }))).toBe('/h/.megabrain/project-pictures/ab.png')
  })
})

describe('pictureUrl', () => {
  const toAsset = (path: string) => `asset://localhost${path}`

  test('a file path goes through the asset protocol', () => {
    expect(pictureUrl('/h/.megabrain/project-pictures/ab.png', toAsset)).toBe('asset://localhost/h/.megabrain/project-pictures/ab.png')
  })

  test('a data or https URL is used as it is', () => {
    expect(pictureUrl('data:image/svg+xml,x', toAsset)).toBe('data:image/svg+xml,x')
    expect(pictureUrl('https://example.com/a.png', toAsset)).toBe('https://example.com/a.png')
  })

  test('a file path without the asset protocol cannot show', () => {
    expect(pictureUrl('/h/a.png', null)).toBeNull()
  })
})

describe('compareByDisplayName', () => {
  test('sorts by display name, ignoring case', () => {
    const list = [
      { name: 'megabrain', path: '/m' },
      { name: 'canto', path: '/c', appearance: { name: 'zebra' } },
      { name: 'Infra', path: '/i' },
      { name: 'alpha', path: '/a' },
    ]
    expect([...list].sort(compareByDisplayName).map(displayName)).toEqual(['alpha', 'Infra', 'megabrain', 'zebra'])
  })

  test('two equal names keep a stable order by path', () => {
    const list = [
      { name: 'web', path: '/b/web' },
      { name: 'Web', path: '/a/web' },
    ]
    expect([...list].sort(compareByDisplayName).map((item) => item.path)).toEqual(['/a/web', '/b/web'])
  })
})
