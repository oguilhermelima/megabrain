import { describe, expect, test } from 'bun:test'
import { clipRows, collapseContext, editDiffs, writeBases, type EditRow } from '@/chat/edit-diff'

const json = (value: unknown) => JSON.stringify(value)
const kinds = (rows: EditRow[]) => rows.map((row) => row.kind)

describe('editDiffs', () => {
  test('a Claude Edit reads as the lines it removed and added, between the lines both kept', () => {
    const files = editDiffs('Edit', json({ file_path: '/repo/src/a.ts', old_string: 'one\ntwo\nthree', new_string: 'one\nTWO\nthree' }))
    expect(files).toHaveLength(1)
    const [file] = files ?? []
    expect(file?.path).toBe('/repo/src/a.ts')
    expect(file?.status).toBe('modified')
    expect([file?.added, file?.removed]).toEqual([1, 1])
    expect(file?.lines.map((line) => [line.kind, line.text])).toEqual([
      ['context', 'one'],
      ['del', 'two'],
      ['add', 'TWO'],
      ['context', 'three'],
    ])
    // An Edit says nothing about where in the file it landed.
    expect(file?.lines.every((line) => line.oldLine === null && line.newLine === null)).toBe(true)
  })

  test('a MultiEdit is one file, every edit counted', () => {
    const files = editDiffs(
      'MultiEdit',
      json({
        file_path: '/repo/src/b.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'x\ny', new_string: 'x\ny\nz' },
        ],
      }),
    )
    expect(files).toHaveLength(1)
    expect(files?.[0]?.path).toBe('/repo/src/b.ts')
    expect([files?.[0]?.added, files?.[0]?.removed]).toEqual([2, 1])
    expect(files?.[0]?.lines.filter((line) => line.kind === 'hunk')).toHaveLength(1)
  })

  test('a Write with nothing before it is the whole file added, numbered from 1', () => {
    const files = editDiffs('Write', json({ file_path: '/repo/new.md', content: '# Title\n\nBody\n' }))
    expect(files?.[0]?.status).toBe('added')
    expect([files?.[0]?.added, files?.[0]?.removed]).toEqual([3, 0])
    expect(files?.[0]?.lines.map((line) => [line.kind, line.newLine, line.text])).toEqual([
      ['add', 1, '# Title'],
      ['add', 2, ''],
      ['add', 3, 'Body'],
    ])
  })

  test('a Write over content the chat already wrote reads as the change, numbered on both sides', () => {
    const files = editDiffs('Write', json({ file_path: '/repo/new.md', content: 'a\nB\nc\n' }), 'a\nb\nc\n')
    expect(files?.[0]?.status).toBe('modified')
    expect([files?.[0]?.added, files?.[0]?.removed]).toEqual([1, 1])
    expect(files?.[0]?.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['context', 3, 3],
    ])
  })

  test('a Codex patch over two files is one diff per file', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/one.ts',
      '@@ function seek()',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      '+const c = 4',
      '*** Add File: src/two.ts',
      '+export const two = 2',
      '+export const three = 3',
      '*** End Patch',
    ].join('\n')
    const files = editDiffs('apply_patch', patch)
    expect(files?.map((file) => [file.path, file.status, file.added, file.removed])).toEqual([
      ['src/one.ts', 'modified', 2, 1],
      ['src/two.ts', 'added', 2, 0],
    ])
    expect(files?.[0]?.lines[0]).toEqual({ kind: 'hunk', text: '@@ function seek()', oldLine: null, newLine: null })
  })

  test('a Codex patch sent as JSON arguments reads the same', () => {
    const files = editDiffs('apply_patch', json({ input: '*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch\n' }))
    expect(files?.map((file) => [file.path, file.status])).toEqual([['gone.ts', 'deleted']])
  })

  test('a Codex file change carries a numbered unified diff per file', () => {
    const files = editDiffs(
      'fileChange',
      json({
        changes: [
          { path: 'src/a.ts', kind: { type: 'update' }, diff: '@@ -10,2 +10,2 @@\n keep\n-old\n+new\n' },
          { path: 'src/b.ts', kind: { type: 'add' }, diff: 'line one\nline two\n' },
        ],
      }),
    )
    expect(files?.map((file) => [file.path, file.status, file.added, file.removed])).toEqual([
      ['src/a.ts', 'modified', 1, 1],
      ['src/b.ts', 'added', 2, 0],
    ])
    expect(files?.[0]?.lines.find((line) => line.kind === 'add')?.newLine).toBe(11)
  })

  test('calls that edit nothing have no diff', () => {
    expect(editDiffs('Read', json({ file_path: '/repo/a.ts' }))).toBeNull()
    expect(editDiffs('Edit', undefined)).toBeNull()
    expect(editDiffs('Edit', 'not json')).toBeNull()
  })

  test('an unreadable Codex patch has no file diff or line counts', () => {
    const files = editDiffs('apply_patch', json({ input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch\n' }))
    expect(files).toBeNull()
  })
})

describe('collapseContext', () => {
  const context = (count: number, from = 0) => Array.from({ length: count }, (_, index) => ({ kind: 'context' as const, text: `c${from + index}`, oldLine: null, newLine: null }))
  const add = { kind: 'add' as const, text: 'new', oldLine: null, newLine: null }

  test('keeps three lines of context either side of a change and folds the rest', () => {
    const rows = collapseContext([...context(5), add, ...context(10, 5), add, ...context(4, 15)])
    expect(kinds(rows)).toEqual(['skip', 'context', 'context', 'context', 'add', 'context', 'context', 'context', 'skip', 'context', 'context', 'context', 'add', 'context', 'context', 'context', 'skip'])
    expect(rows[0]?.kind === 'skip' ? rows[0].lines.map((line) => line.text) : null).toEqual(['c0', 'c1'])
    expect(rows[8]?.kind === 'skip' ? rows[8].lines.length : null).toBe(4)
  })

  test('a gap of six lines or fewer stays whole', () => {
    expect(kinds(collapseContext([add, ...context(6), add]))).toEqual(['add', ...Array(6).fill('context'), 'add'])
  })
})

describe('clipRows', () => {
  test('a diff over the cap shows its first rows and says how many it held back', () => {
    const rows = Array.from({ length: 450 }, (_, index) => ({ kind: 'add' as const, text: String(index), oldLine: null, newLine: null }))
    const clip = clipRows(rows, 400)
    expect(clip.shown).toHaveLength(400)
    expect(clip.hidden).toBe(50)
    expect(clipRows(rows.slice(0, 400), 400).hidden).toBe(0)
  })
})

describe('writeBases', () => {
  test('a Write is compared with the last content the chat gave that path, Edits applied to it', () => {
    const bases = writeBases([
      { id: 'w1', name: 'Write', input: json({ file_path: '/r/a.ts', content: 'a\nb\n' }) },
      { id: 'e1', name: 'Edit', input: json({ file_path: '/r/a.ts', old_string: 'b', new_string: 'B' }) },
      { id: 'w2', name: 'Write', input: json({ file_path: '/r/a.ts', content: 'a\nB\nc\n' }) },
      { id: 'w3', name: 'Write', input: json({ file_path: '/r/other.ts', content: 'x' }) },
    ])
    expect(bases.get('w1')).toBeUndefined()
    expect(bases.get('w2')).toBe('a\nB\n')
    expect(bases.get('w3')).toBeUndefined()
  })

  test('an Edit whose text is not in the tracked content stops tracking that path', () => {
    const bases = writeBases([
      { id: 'w1', name: 'Write', input: json({ file_path: '/r/a.ts', content: 'a\n' }) },
      { id: 'e1', name: 'Edit', input: json({ file_path: '/r/a.ts', old_string: 'missing', new_string: 'x' }) },
      { id: 'w2', name: 'Write', input: json({ file_path: '/r/a.ts', content: 'b\n' }) },
    ])
    expect(bases.get('w2')).toBeUndefined()
  })
})
