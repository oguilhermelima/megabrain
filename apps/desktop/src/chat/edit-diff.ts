import { parsePatch, type DiffLine } from '@/github/review-model'

// What an edit call changed, read from its input alone: Claude's Edit, MultiEdit, Write and
// NotebookEdit, Codex's apply_patch text and its file change items. Each file it touched reads as
// diff lines, numbered only where the input says where they are (a whole file written, a unified
// diff), with the lines added and removed counted.

export interface FileEdit {
  path: string
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
  lines: DiffLine[]
}

/** A diff as drawn: its lines, with long runs of unchanged lines folded into one row. */
export type EditRow = DiffLine | { kind: 'skip'; lines: DiffLine[] }

const line = (kind: DiffLine['kind'], text: string, oldLine: number | null = null, newLine: number | null = null): DiffLine => ({ kind, text, oldLine, newLine })

/** A text's lines; a final newline ends the last line rather than starting an empty one. */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// Above this many cells the longest common subsequence costs too much; the middle reads as replaced.
const maxCells = 2_000_000

/** A line diff of two texts; `numbered` when both are whole files, so line numbers are real. */
export function lineDiff(before: string, after: string, numbered = false): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  // kind per step of the middle, walked from its start.
  const steps: ('context' | 'del' | 'add')[] = []
  const n = endA - start
  const m = endB - start
  if (n * m <= maxCells) {
    // lengths[i][j]: the common subsequence of a[start+i..endA) and b[start+j..endB).
    const lengths = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      const row = lengths[i]
      const below = lengths[i + 1]
      if (row === undefined || below === undefined) continue
      for (let j = m - 1; j >= 0; j--) row[j] = a[start + i] === b[start + j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        steps.push('context')
        i++
        j++
      } else if (j < m && (i === n || (lengths[i]?.[j + 1] ?? 0) >= (lengths[i + 1]?.[j] ?? 0))) {
        steps.push('add')
        j++
      } else {
        steps.push('del')
        i++
      }
    }
  } else {
    for (let i = 0; i < n; i++) steps.push('del')
    for (let j = 0; j < m; j++) steps.push('add')
  }
  // A removal reads before the addition that replaces it.
  const ordered: typeof steps = []
  for (let index = 0; index < steps.length;) {
    if (steps[index] === 'context') {
      ordered.push('context')
      index++
      continue
    }
    let end = index
    while (end < steps.length && steps[end] !== 'context') end++
    const run = steps.slice(index, end)
    ordered.push(...run.filter((step) => step === 'del'), ...run.filter((step) => step === 'add'))
    index = end
  }
  const lines: DiffLine[] = []
  let oldIndex = 0
  let newIndex = 0
  const number = (index: number) => (numbered ? index + 1 : null)
  const push = (kind: 'context' | 'del' | 'add') => {
    if (kind === 'context') lines.push(line('context', a[oldIndex] ?? '', number(oldIndex++), number(newIndex++)))
    else if (kind === 'del') lines.push(line('del', a[oldIndex] ?? '', number(oldIndex++), null))
    else lines.push(line('add', b[newIndex] ?? '', null, number(newIndex++)))
  }
  for (let index = 0; index < start; index++) push('context')
  for (const step of ordered) push(step)
  for (let index = endA; index < a.length; index++) push('context')
  return lines
}

function fileEdit(path: string, status: FileEdit['status'], lines: DiffLine[]): FileEdit {
  let added = 0
  let removed = 0
  for (const entry of lines) {
    if (entry.kind === 'add') added++
    else if (entry.kind === 'del') removed++
  }
  return { path, status, added, removed, lines }
}

const text = (value: unknown) => (typeof value === 'string' ? value : null)
const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null)

const patchFile = /^\*\*\* (Update|Add|Delete) File: (.+)$/

/** Codex's apply_patch text: each Update, Add or Delete section as one file. */
function patchFiles(patch: string): FileEdit[] {
  const files: FileEdit[] = []
  let current: {
    path: string
    status: FileEdit['status']
    lines: DiffLine[]
  } | null = null
  const close = () => {
    if (current !== null) files.push(fileEdit(current.path, current.status, current.lines))
    current = null
  }
  for (const raw of patch.split('\n')) {
    const header = patchFile.exec(raw)
    if (header !== null) {
      close()
      const verb = header[1]
      current = {
        path: (header[2] ?? '').trim(),
        status: verb === 'Add' ? 'added' : verb === 'Delete' ? 'deleted' : 'modified',
        lines: [],
      }
      continue
    }
    if (raw.startsWith('*** ')) {
      // End Patch, End of File, Move to: none of them is a line of the file.
      if (raw.startsWith('*** End Patch')) close()
      continue
    }
    if (current === null) continue
    const target: { lines: DiffLine[] } = current
    if (raw.startsWith('@@')) target.lines.push(line('hunk', raw))
    else if (raw.startsWith('+')) target.lines.push(line('add', raw.slice(1)))
    else if (raw.startsWith('-')) target.lines.push(line('del', raw.slice(1)))
    else if (raw.startsWith(' ')) target.lines.push(line('context', raw.slice(1)))
  }
  close()
  return files
}

const changeStatus = (kind: unknown): FileEdit['status'] => {
  const name = (text(kind) ?? text(record(kind)?.type) ?? '').toLowerCase()
  return name === 'add' ? 'added' : name === 'delete' ? 'deleted' : 'modified'
}

/** One Codex file change: a unified diff for an update, the file's text for an add or a delete. */
function changeEdit(path: string, status: FileEdit['status'], diff: string): FileEdit {
  if (status === 'added') return fileEdit(path, status, lineDiff('', diff, true))
  if (status === 'deleted') return fileEdit(path, status, lineDiff(diff, '', true))
  const numbered = parsePatch(diff)
  return fileEdit(path, status, numbered.length > 0 ? numbered : (patchFiles(`*** Update File: ${path}\n${diff}`)[0]?.lines ?? []))
}

/** Codex's file change items: `changes` as a list of {path, kind, diff}, or keyed by path. */
function changeFiles(changes: unknown): FileEdit[] | null {
  if (Array.isArray(changes)) {
    const files = changes.flatMap((entry) => {
      const change = record(entry)
      const path = text(change?.path)
      return change === null || path === null ? [] : [changeEdit(path, changeStatus(change.kind), text(change.diff) ?? '')]
    })
    return files.length > 0 ? files : null
  }
  const keyed = record(changes)
  if (keyed === null) return null
  const files = Object.entries(keyed).flatMap(([path, value]) => {
    const change = record(value)
    const add = record(change?.add)
    const remove = record(change?.delete)
    const update = record(change?.update)
    if (add !== null) return [changeEdit(path, 'added', text(add.content) ?? '')]
    if (remove !== null) return [changeEdit(path, 'deleted', text(remove.content) ?? '')]
    if (update !== null) return [changeEdit(path, 'modified', text(update.unified_diff) ?? '')]
    return []
  })
  return files.length > 0 ? files : null
}

const fromPatch = (value: string | null) => {
  const begin = value?.indexOf('*** Begin Patch') ?? -1
  if (value === null || (begin < 0 && !patchFile.test(value.split('\n')[0] ?? ''))) return null
  const files = patchFiles(begin < 0 ? value : value.slice(begin))
  return files.length > 0 ? files : null
}

/**
 * The files an edit call changed, from its input; null for a call that edits nothing. `previous` is
 * what the chat last left in a Write's file, when it knows, so the Write reads as a change.
 */
export function editDiffs(name: string, input: string | undefined, previous?: string): FileEdit[] | null {
  if (input === undefined || input.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    // Not JSON: Codex's raw apply_patch text.
    return fromPatch(input)
  }
  const fields = record(parsed)
  if (fields === null) return fromPatch(text(parsed))
  const path = text(fields.file_path) ?? text(fields.notebook_path) ?? text(fields.path)
  const tool = name.toLowerCase()
  if (tool === 'edit' && path !== null) return [fileEdit(path, 'modified', lineDiff(text(fields.old_string) ?? '', text(fields.new_string) ?? ''))]
  if (tool === 'multiedit' && path !== null && Array.isArray(fields.edits)) {
    const lines = fields.edits.flatMap((entry, index) => {
      const edit = record(entry)
      const diff = lineDiff(text(edit?.old_string) ?? '', text(edit?.new_string) ?? '')
      return index === 0 ? diff : [line('hunk', ''), ...diff]
    })
    return [fileEdit(path, 'modified', lines)]
  }
  if (tool === 'write' && path !== null) {
    const content = text(fields.content) ?? ''
    return [fileEdit(path, previous === undefined ? 'added' : 'modified', lineDiff(previous ?? '', content, true))]
  }
  if (tool === 'notebookedit' && path !== null) {
    if (text(fields.edit_mode) === 'delete') return null
    return [fileEdit(path, 'modified', lineDiff('', text(fields.new_source) ?? ''))]
  }
  const changes = changeFiles(fields.changes)
  if (changes !== null) return changes
  for (const candidate of [fields.input, fields.patch, Array.isArray(fields.command) ? fields.command.at(-1) : fields.command]) {
    const files = fromPatch(text(candidate))
    if (files !== null) return files
  }
  return null
}

/** A call's lines added and removed over every file it touched. */
export function editTotals(files: FileEdit[]): {
  added: number
  removed: number
} {
  return files.reduce(
    (total, file) => ({
      added: total.added + file.added,
      removed: total.removed + file.removed,
    }),
    { added: 0, removed: 0 },
  )
}

/** Unchanged lines kept beside each change; a longer run folds into one row. */
const keptContext = 3

/** The rows a diff draws: three unchanged lines either side of each change, the rest folded. */
export function collapseContext(lines: DiffLine[], keep = keptContext): EditRow[] {
  const rows: EditRow[] = []
  let index = 0
  while (index < lines.length) {
    const entry = lines[index]
    if (entry === undefined) break
    if (entry.kind !== 'context') {
      rows.push(entry)
      index++
      continue
    }
    let end = index
    while (end < lines.length && lines[end]?.kind === 'context') end++
    const run = lines.slice(index, end)
    const before = index > 0 && lines[index - 1]?.kind !== 'hunk' ? keep : 0
    const after = end < lines.length && lines[end]?.kind !== 'hunk' ? keep : 0
    if (run.length <= before + after) rows.push(...run)
    else {
      rows.push(...run.slice(0, before), { kind: 'skip', lines: run.slice(before, run.length - after) }, ...run.slice(run.length - after))
    }
    index = end
  }
  return rows
}

/** Rows a diff shows before Show more. */
export const diffRowCap = 400

/** The first `cap` rows of a diff, and how many it held back. */
export function clipRows(rows: EditRow[], cap = diffRowCap): { shown: EditRow[]; hidden: number } {
  return rows.length > cap ? { shown: rows.slice(0, cap), hidden: rows.length - cap } : { shown: rows, hidden: 0 }
}

/**
 * For each Write over a file the chat already wrote, the content it replaced: the earlier Write with
 * every later Edit applied. A path stops being tracked when an Edit's text is not found in it.
 */
export function writeBases(calls: { id: string; name: string; input: string | undefined }[]): Map<string, string> {
  const contents = new Map<string, string>()
  const bases = new Map<string, string>()
  const replace = (path: string, edits: unknown[]) => {
    let content = contents.get(path)
    for (const entry of edits) {
      const edit = record(entry)
      const from = text(edit?.old_string)
      const to = text(edit?.new_string) ?? ''
      if (content === undefined || from === null || from === '' || !content.includes(from)) {
        contents.delete(path)
        return
      }
      content = edit?.replace_all === true ? content.split(from).join(to) : content.replace(from, () => to)
    }
    if (content !== undefined) contents.set(path, content)
  }
  for (const call of calls) {
    const tool = call.name.toLowerCase()
    if (tool !== 'write' && tool !== 'edit' && tool !== 'multiedit') continue
    let fields: Record<string, unknown> | null = null
    try {
      fields = record(JSON.parse(call.input ?? ''))
    } catch {
      continue
    }
    const path = text(fields?.file_path)
    if (fields === null || path === null) continue
    if (tool === 'write') {
      const before = contents.get(path)
      if (before !== undefined) bases.set(call.id, before)
      contents.set(path, text(fields.content) ?? '')
    } else if (contents.has(path)) replace(path, tool === 'edit' ? [fields] : Array.isArray(fields.edits) ? fields.edits : [])
  }
  return bases
}
