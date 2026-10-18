export type PathSegment = { kind: 'text'; text: string } | { kind: 'path'; text: string; path: string; line: number | null }

// An absolute path runs to the next space, quote, bracket or backtick.
const candidate = /\/[^\s`'"<>()[\]{}]+/g
// What may come right before one: the start of the text, a space, an opening quote or bracket.
const boundary = /[\s`'"([{<]/
const trailingPunctuation = /[.,;:!?]+$/
const lineSuffix = /^(.*?)(?::(\d+)(?::\d+)?)?$/

/** Splits text into plain runs and the absolute paths under `root` it names, each with the line
 * after it (`path:12` or `path:12:3`). Paths outside the root and the root itself stay text, and
 * sentence punctuation after a path is not part of it. */
export function pathSegments(text: string, root: string | null): PathSegment[] {
  const base = (root ?? '').replace(/\/+$/, '')
  if (base === '') return [{ kind: 'text', text }]
  const prefix = `${base}/`
  const segments: PathSegment[] = []
  let last = 0
  for (const match of text.matchAll(candidate)) {
    const start = match.index
    const before = text.charAt(start - 1)
    if (start > 0 && !boundary.test(before)) continue
    const raw = match[0].replace(trailingPunctuation, '')
    const parts = lineSuffix.exec(raw)
    const path = parts?.[1] ?? raw
    if (!path.startsWith(prefix) || path.length === prefix.length) continue
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) })
    const line = parts?.[2]
    segments.push({ kind: 'path', text: raw, path, line: line === undefined ? null : Number(line) })
    last = start + raw.length
  }
  if (last < text.length || segments.length === 0) segments.push({ kind: 'text', text: text.slice(last) })
  return segments
}

/** The first path under `root` a text names, for a row that can only offer one. */
export function firstPath(text: string, root: string | null): Extract<PathSegment, { kind: 'path' }> | null {
  return pathSegments(text, root).find((segment) => segment.kind === 'path') ?? null
}

/** A local file a link points at, with the project or worktree whose Code opens it. */
export interface FileTarget {
  root: string
  path: string
  line: number | null
}

const scheme = /^[a-z][a-z0-9+.-]*:/i
const lineFragment = /#L(\d+)(?:-L?\d+)?$/

/** Where a chat link to a local file opens in Code: a file URL, an absolute path, or a path relative
 * to the chat's worktree (`base`), under one of `roots` (the most specific when they nest), with the
 * line it names (`:12`, `:12:3` or `#L12`). Web and other links, folders (a trailing slash or a root
 * itself), paths outside every root and paths with `.` or `..` segments are null. */
export function localFileTarget(href: string, base: string | null, roots: readonly string[]): FileTarget | null {
  let raw = href.trim()
  let line: number | null = null
  const fragment = lineFragment.exec(raw)
  if (fragment !== null) {
    line = Number(fragment[1])
    raw = raw.slice(0, fragment.index)
  }
  if (/^file:/i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return null
    }
    if (url.host !== '' && url.host !== 'localhost') return null
    raw = url.pathname
  } else if (scheme.test(raw) || raw === '' || raw.startsWith('#')) {
    return null
  } else if (!raw.startsWith('/')) {
    if (base === null) return null
    raw = `${base.replace(/\/+$/, '')}/${raw.replace(/^\.\//, '')}`
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  const parts = lineSuffix.exec(decoded)
  const path = parts?.[1] ?? decoded
  if (line === null && parts?.[2] !== undefined) line = Number(parts[2])
  if (path.endsWith('/') || path.split('/').some((segment) => segment === '.' || segment === '..')) return null
  let best: string | null = null
  for (const candidate of roots) {
    const trimmed = candidate.replace(/\/+$/, '')
    if (trimmed === '' || !path.startsWith(`${trimmed}/`)) continue
    if (best === null || trimmed.length > best.length) best = trimmed
  }
  return best === null ? null : { root: best, path, line }
}
