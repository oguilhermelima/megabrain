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
