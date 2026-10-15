import type { CodeChange, CodeEntry } from '@/api/schema'

export interface TreeDir {
  kind: 'dir'
  path: string
  name: string
  children: TreeNode[]
}

export interface TreeFile {
  kind: 'file'
  path: string
  name: string
  size: number | null
}

export type TreeNode = TreeDir | TreeFile

function nameOf(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

function parentOf(path: string): string | null {
  const index = path.lastIndexOf('/')
  return index === -1 ? null : path.slice(0, index)
}

/** Builds a nested tree from a flat entry list, directories first, alphabetical within each kind. */
export function buildTree(entries: CodeEntry[]): TreeNode[] {
  const dirs = new Map<string, TreeDir>()
  const roots: TreeNode[] = []

  const ensureDir = (path: string): TreeDir => {
    const existing = dirs.get(path)
    if (existing) return existing
    const node: TreeDir = { kind: 'dir', path, name: nameOf(path), children: [] }
    dirs.set(path, node)
    attach(node, path)
    return node
  }

  const attach = (node: TreeNode, path: string) => {
    const parentPath = parentOf(path)
    if (parentPath === null) {
      roots.push(node)
      return
    }
    ensureDir(parentPath).children.push(node)
  }

  for (const entry of entries) {
    if (entry.kind === 'dir') {
      ensureDir(entry.path)
    } else {
      attach({ kind: 'file', path: entry.path, name: nameOf(entry.path), size: entry.size }, entry.path)
    }
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    for (const node of nodes) if (node.kind === 'dir') sort(node.children)
  }
  sort(roots)

  return roots
}

/** Paths that match the filter (case-insensitive substring), plus every ancestor directory so the
 * matches stay reachable when the tree collapses to just the matching branches. Empty query matches
 * nothing, meaning "no filter active". */
export function matchingPaths(entries: CodeEntry[], query: string): Set<string> {
  const result = new Set<string>()
  const needle = query.trim().toLowerCase()
  if (needle === '') return result

  for (const entry of entries) {
    if (!entry.path.toLowerCase().includes(needle)) continue
    let path: string | null = entry.path
    while (path !== null) {
      result.add(path)
      path = parentOf(path)
    }
  }
  return result
}

const extensionLanguages: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  rs: 'rust',
  css: 'css',
  html: 'html',
  htm: 'html',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
}

/** The language key for a path's extension, or "text" when none is known. */
export function languageForPath(path: string): string {
  const name = nameOf(path)
  const dot = name.lastIndexOf('.')
  if (dot === -1) return 'text'
  const extension = name.slice(dot + 1).toLowerCase()
  return extensionLanguages[extension] ?? 'text'
}

const statusLetters: Record<CodeChange['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

/** The single-letter status badge for a change, as git-style tooling shows it. */
export function statusLetter(status: CodeChange['status']): string {
  return statusLetters[status]
}
