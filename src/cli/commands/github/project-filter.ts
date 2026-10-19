export type FilterItem = { id: string; title: string; type: string; state: string | null; repository: string | null; status: string | null; assignees: { login: string }[]; labels: { name: string }[]; fields: Record<string, unknown> }
export type FilterResult<T> = { items: T[]; warnings: string[] }

function tokens(source: string): string[] {
  const out: string[] = []
  let token = '', quoted = false
  for (const char of source) {
    if (char === '"') { quoted = !quoted; continue }
    if (/\s/.test(char) && !quoted) { if (token) out.push(token); token = '' } else token += char
  }
  if (token) out.push(token)
  return out
}
function norm(value: unknown): string { return String(value ?? '').toLocaleLowerCase() }
function compare(actual: unknown, expected: string, today: string): boolean {
  const m = expected.match(/^(>=|<=|>|<|=)?(.+)$/)
  if (!m) return false
  let target = m[2]!
  const op = m[1] ?? '='
  const rel = target.match(/^@today(?:([+-])(\d+)([dwmy]))?$/i)
  if (rel) {
    const d = new Date(`${today}T00:00:00Z`)
    if (rel[1]) { const n = Number(rel[2]); if (rel[3] === 'd') d.setUTCDate(d.getUTCDate() + (rel[1] === '-' ? -n : n)); else if (rel[3] === 'w') d.setUTCDate(d.getUTCDate() + (rel[1] === '-' ? -7*n : 7*n)); else if (rel[3] === 'm') d.setUTCMonth(d.getUTCMonth() + (rel[1] === '-' ? -n : n)); else d.setUTCFullYear(d.getUTCFullYear() + (rel[1] === '-' ? -n : n)) }
    target = d.toISOString().slice(0, 10)
  }
  const a = typeof actual === 'number' ? actual : Date.parse(String(actual)) || Number(actual)
  const b = /^\d+(?:\.\d+)?$/.test(target) ? Number(target) : Date.parse(target)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return norm(actual) === norm(target)
  return op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : op === '<=' ? a <= b : a === b
}

export function evaluateProjectFilter<T extends FilterItem>(source: string, items: readonly T[], options: { today?: string; me?: string } = {}): FilterResult<T> {
  const warnings = new Set<string>()
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const predicates = tokens(source).map((token) => {
    const negative = token.startsWith('-')
    const value = negative ? token.slice(1) : token
    const colon = value.indexOf(':')
    const key = colon < 0 ? '' : value.slice(0, colon).toLocaleLowerCase()
    const wanted = colon < 0 ? value : value.slice(colon + 1)
    const compareField = Object.keys(items[0]?.fields ?? {}).find((f) => norm(f) === norm(key))
    let predicate: (item: T) => boolean
    if (!key) predicate = (i) => norm(i.title).includes(norm(value))
    else if (key === 'is') predicate = (i) => wanted.toLowerCase() === 'open' ? i.state === 'OPEN' : wanted.toLowerCase() === 'closed' ? i.state === 'CLOSED' : wanted.toLowerCase() === 'issue' ? i.type === 'ISSUE' : wanted.toLowerCase() === 'pr' ? i.type === 'PULL_REQUEST' : wanted.toLowerCase() === 'draft' ? i.type === 'DRAFT_ISSUE' : true
    else if (key === 'no') predicate = (i) => wanted.toLowerCase() === 'status' ? i.status === null : wanted.toLowerCase() === 'assignee' ? !i.assignees.length : wanted.toLowerCase() === 'label' ? !i.labels.length : i.fields[wanted] == null
    else if (key === 'has') predicate = (i) => wanted.toLowerCase() === 'assignee' ? !!i.assignees.length : wanted.toLowerCase() === 'label' ? !!i.labels.length : wanted.toLowerCase() === 'status' ? i.status !== null : i.fields[wanted] != null
    else if (key === 'assignee') predicate = (i) => i.assignees.some((a) => wanted === '@me' && !options.me || norm(a.login) === norm(wanted === '@me' ? options.me : wanted))
    else if (key === 'label') predicate = (i) => i.labels.some((a) => norm(a.name) === norm(wanted))
    else if (key === 'repo') predicate = (i) => norm(i.repository) === norm(wanted)
    else if (key === 'status') predicate = (i) => wanted.split(',').some((v) => norm(i.status) === norm(v))
    else if (compareField || ['estimate','size','priority','updated','created','closed','start date','target date'].includes(key)) predicate = (i) => compare(i.fields[compareField ?? key] ?? (key === 'updated' ? i.fields.Updated : undefined), wanted, today)
    else if (key === 'title') predicate = (i) => norm(i.title).includes(norm(wanted))
    else { warnings.add(token); predicate = () => true }
    return (i: T) => negative ? !predicate(i) : predicate(i)
  })
  return { items: items.filter((item) => predicates.every((predicate) => predicate(item))), warnings: [...warnings] }
}
