import { describe, expect, test } from 'bun:test'
import { localFileTarget, pathSegments } from '@/code/chat-paths'

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

describe('localFileTarget', () => {
  const project = '/Users/operator/Workspaces/canto'
  const roots = [root, project]
  const target = (href: string, base: string | null = root) => localFileTarget(href, base, roots)

  test('an absolute path under the chat worktree opens there', () => {
    expect(target(`${root}/src/player.ts`)).toEqual({ root, path: `${root}/src/player.ts`, line: null })
  })

  test('a path under another listed project opens in that project', () => {
    expect(target(`${project}/data/report.csv`)).toEqual({ root: project, path: `${project}/data/report.csv`, line: null })
  })

  test('the most specific root wins when roots nest', () => {
    const nested = `${project}/.worktrees/feat-x`
    expect(localFileTarget(`${nested}/a.pdf`, null, [project, nested])).toEqual({ root: nested, path: `${nested}/a.pdf`, line: null })
  })

  test('a file URL opens like its path, percent escapes decoded', () => {
    expect(target(`file://${project}/My%20Sheet.xlsx`)).toEqual({ root: project, path: `${project}/My Sheet.xlsx`, line: null })
    expect(target(`file://localhost${project}/a.csv`)).toEqual({ root: project, path: `${project}/a.csv`, line: null })
  })

  test('a file URL on another host stays put', () => {
    expect(target(`file://server${project}/a.csv`)).toBeNull()
  })

  test('a relative link resolves against the chat worktree', () => {
    expect(target('src/player.ts')).toEqual({ root, path: `${root}/src/player.ts`, line: null })
    expect(target('./docs/My%20Notes.md')).toEqual({ root, path: `${root}/docs/My Notes.md`, line: null })
  })

  test('a relative link with no chat worktree stays put', () => {
    expect(target('src/player.ts', null)).toBeNull()
  })

  test('a line after the path, or a #L fragment, is the line to open at', () => {
    expect(target(`${root}/src/player.ts:42`)).toEqual({ root, path: `${root}/src/player.ts`, line: 42 })
    expect(target(`${root}/src/player.ts:42:7`)).toEqual({ root, path: `${root}/src/player.ts`, line: 42 })
    expect(target('src/player.ts#L12')).toEqual({ root, path: `${root}/src/player.ts`, line: 12 })
    expect(target('src/player.ts#L12-L20')).toEqual({ root, path: `${root}/src/player.ts`, line: 12 })
  })

  test('web, mail and other scheme links are not files', () => {
    expect(target('https://example.com/a.csv')).toBeNull()
    expect(target('mailto:someone@example.com')).toBeNull()
    expect(target('vscode://file/x')).toBeNull()
    expect(target('#section')).toBeNull()
  })

  test('folders keep their behaviour: a trailing slash or a root itself', () => {
    expect(target(`${root}/src/`)).toBeNull()
    expect(target(root)).toBeNull()
    expect(target(`file://${project}`)).toBeNull()
  })

  test('paths outside every listed root, or climbing out with .., stay put', () => {
    expect(target('/etc/passwd')).toBeNull()
    expect(target(`${root}-other/a.ts`)).toBeNull()
    expect(target(`${root}/../secret.txt`)).toBeNull()
    expect(target('../secret.txt')).toBeNull()
    expect(target(`file://${project}/%2E%2E/x`)).toBeNull()
  })

  test('an empty or malformed link stays put', () => {
    expect(target('')).toBeNull()
    expect(target('src/%E0%A4%A.ts')).toBeNull()
  })
})
