import { describe, expect, test } from 'bun:test'
import { pathSegments } from '@/code/chat-paths'

const root = '/Users/operator/Workspaces/Worktrees/fix-player-seek'
const links = (text: string, base: string | null = root) => pathSegments(text, base).filter((segment) => segment.kind === 'path')

describe('pathSegments', () => {
  test('text without a path is one text segment', () => {
    expect(pathSegments('nothing to see here', root)).toEqual([{ kind: 'text', text: 'nothing to see here' }])
  })

  test('finds an absolute path under the worktree and keeps the text around it', () => {
    expect(pathSegments(`Edited ${root}/src/player.ts today`, root)).toEqual([
      { kind: 'text', text: 'Edited ' },
      { kind: 'path', text: `${root}/src/player.ts`, path: `${root}/src/player.ts`, line: null },
      { kind: 'text', text: ' today' },
    ])
  })

  test('reads a line after the path', () => {
    expect(links(`see ${root}/src/player.ts:42`)).toEqual([{ kind: 'path', text: `${root}/src/player.ts:42`, path: `${root}/src/player.ts`, line: 42 }])
  })

  test('reads a line and a column, keeping the line', () => {
    expect(links(`${root}/src/player.ts:42:7 fails`)).toEqual([{ kind: 'path', text: `${root}/src/player.ts:42:7`, path: `${root}/src/player.ts`, line: 42 }])
  })

  test('ignores a path outside the worktree', () => {
    expect(links('/etc/hosts and /Users/operator/Workspaces/canto/src/a.ts')).toEqual([])
  })

  test('ignores a sibling folder that only shares the prefix', () => {
    expect(links(`${root}-old/src/a.ts`)).toEqual([])
  })

  test('ignores the worktree folder itself', () => {
    expect(links(`cd ${root} first`)).toEqual([])
  })

  test('leaves trailing punctuation out of the link', () => {
    expect(links(`Look at ${root}/a.ts.`).map((segment) => segment.text)).toEqual([`${root}/a.ts`])
    expect(links(`(${root}/a.ts:3), then`).map((segment) => segment.text)).toEqual([`${root}/a.ts:3`])
    expect(links(`${root}/a.ts: done`).map((segment) => segment.text)).toEqual([`${root}/a.ts`])
  })

  test('the punctuation stays in the text', () => {
    expect(pathSegments(`${root}/a.ts.`, root).map((segment) => segment.text).join('')).toBe(`${root}/a.ts.`)
  })

  test('finds a path inside quotes or backticks', () => {
    expect(links(`"${root}/a.ts" and \`${root}/b.ts:9\``).map((segment) => segment.text)).toEqual([`${root}/a.ts`, `${root}/b.ts:9`])
  })

  test('finds several paths in one text', () => {
    expect(links(`${root}/a.ts, ${root}/b/c.ts:1`)).toHaveLength(2)
  })

  test('a root given with a trailing slash still matches', () => {
    expect(links(`${root}/a.ts`, `${root}/`)).toHaveLength(1)
  })

  test('no worktree means no links', () => {
    expect(pathSegments(`${root}/a.ts`, null)).toEqual([{ kind: 'text', text: `${root}/a.ts` }])
    expect(pathSegments(`${root}/a.ts`, '')).toEqual([{ kind: 'text', text: `${root}/a.ts` }])
  })
})
