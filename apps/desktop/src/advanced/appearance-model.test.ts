import { describe, expect, test } from 'bun:test'
import { byDisplayName, compareByDisplayName, compareNames, customPicture, droppedPicture, displayName, isHexColor, nameEdit, pictureUrl, projectTint, tintSwatches } from '@/advanced/appearance-model'

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

describe('compareNames', () => {
  test('ignores case and accents', () => {
    expect(compareNames('Éclair', 'eclair')).toBe(0)
    expect(['fig', 'Éclair', 'delta'].sort(compareNames)).toEqual(['delta', 'Éclair', 'fig'])
  })
})

describe('byDisplayName', () => {
  const entries = [
    { label: 'stack', project: { name: 'stack', path: '/w/stack' } },
    { label: 'canto-space', project: { name: 'canto-space', path: '/w/canto-space', appearance: { name: 'inOrb' } } },
    { label: 'Canto', project: { name: 'Canto', path: '/w/Canto', appearance: { name: '' } } },
    { label: 'ávila', project: { name: 'ávila', path: '/w/avila' } },
    { label: 'megabrain', project: { name: 'megabrain', path: '/w/megabrain', appearance: { name: '   ' } } },
  ]

  test('orders entries by display name, ignoring case and accents', () => {
    expect(byDisplayName(entries, (entry) => entry.project).map((entry) => displayName(entry.project))).toEqual(['ávila', 'Canto', 'inOrb', 'megabrain', 'stack'])
  })

  test('an entry without a display name sorts by its folder name', () => {
    const order = byDisplayName(entries, (entry) => entry.project).map((entry) => entry.label)
    expect(order.indexOf('Canto')).toBeLessThan(order.indexOf('canto-space'))
    expect(order.indexOf('megabrain')).toBeGreaterThan(order.indexOf('canto-space'))
  })

  test('leaves the list it was given as it was', () => {
    const before = entries.map((entry) => entry.label)
    byDisplayName(entries, (entry) => entry.project)
    expect(entries.map((entry) => entry.label)).toEqual(before)
  })
})

describe('droppedPicture', () => {
  test('one image file is the picture, whatever the case of its extension', () => {
    expect(droppedPicture(['/h/logo.png'])).toBe('/h/logo.png')
    expect(droppedPicture(['/h/Logo.JPEG'])).toBe('/h/Logo.JPEG')
    expect(droppedPicture(['/h/mark.svg'])).toBe('/h/mark.svg')
  })

  test('anything but one image is not', () => {
    expect(droppedPicture([])).toBeNull()
    expect(droppedPicture(['/h/a.png', '/h/b.png'])).toBeNull()
    expect(droppedPicture(['/h/notes.pdf'])).toBeNull()
    expect(droppedPicture(['/h/folder'])).toBeNull()
    expect(droppedPicture(['/h/v1.png/readme'])).toBeNull()
  })
})
