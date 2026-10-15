import { describe, expect, test } from 'bun:test'
import { toolSummary } from '@/chat/conversation-model'

describe('toolSummary', () => {
  test('Bash shows the command itself', () => {
    expect(toolSummary('Bash', JSON.stringify({ command: 'docker exec -it db psql', description: 'Open psql' }))).toBe('docker exec -it db psql')
  })

  test('a multi-line command shows its first line', () => {
    expect(toolSummary('Bash', JSON.stringify({ command: 'cd app\nbun test' }))).toBe('cd app')
  })

  test('a command given as an argument list is joined', () => {
    expect(toolSummary('shell', JSON.stringify({ command: ['git', 'status', '--short'] }))).toBe('git status --short')
  })

  test('Read, Edit and Write show the file path', () => {
    expect(toolSummary('Read', JSON.stringify({ file_path: '/repo/src/a.ts', limit: 20 }))).toBe('/repo/src/a.ts')
    expect(toolSummary('Edit', JSON.stringify({ file_path: '/repo/src/b.ts', old_string: 'x', new_string: 'y' }))).toBe('/repo/src/b.ts')
    expect(toolSummary('Write', JSON.stringify({ content: 'body', file_path: '/repo/c.md' }))).toBe('/repo/c.md')
  })

  test('Grep and Glob show the pattern', () => {
    expect(toolSummary('Grep', JSON.stringify({ path: 'src', pattern: 'useState' }))).toBe('useState')
    expect(toolSummary('Glob', JSON.stringify({ pattern: '**/*.tsx' }))).toBe('**/*.tsx')
  })

  test('any other tool shows its first string field', () => {
    expect(toolSummary('WebFetch', JSON.stringify({ retries: 2, url: 'https://example.com', prompt: 'read it' }))).toBe('https://example.com')
  })

  test('a known tool without its field falls back to the first string field', () => {
    expect(toolSummary('Bash', JSON.stringify({ description: 'list files' }))).toBe('list files')
  })

  test('input that is not JSON shows its first line', () => {
    expect(toolSummary('shell', 'ls -la\nmore')).toBe('ls -la')
  })

  test('JSON with no string field shows nothing rather than raw JSON', () => {
    expect(toolSummary('Thing', JSON.stringify({ count: 3, nested: { a: 1 } }))).toBe('')
    expect(toolSummary('Thing', '[1,2]')).toBe('')
  })

  test('no input shows nothing', () => {
    expect(toolSummary('Bash', undefined)).toBe('')
    expect(toolSummary('Bash', '')).toBe('')
  })
})
