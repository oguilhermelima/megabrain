import type { SlashCommand } from '@/api/schema'

// Pure logic for the menu the skills button and the slash command share: a fuzzy search with the
// matched letters, the sections with their counts, and the recent picks.

/** A highlighted stretch of text, start inclusive and end exclusive. */
export type Range = [number, number]

export interface FuzzyMatch {
  /** Lower is better: 0 exact, 1 prefix, 2 substring, 3 scattered letters, 10 description. */
  score: number
  field: 'name' | 'description'
  ranges: Range[]
}

function merge(positions: number[]): Range[] {
  const ranges: Range[] = []
  for (const position of positions) {
    const last = ranges.at(-1)
    if (last !== undefined && last[1] === position) last[1] = position + 1
    else ranges.push([position, position + 1])
  }
  return ranges
}

/** The query's letters in order inside the name, else as one piece of the description; null when neither holds them. */
export function fuzzyMatch(query: string, name: string, description: string | null): FuzzyMatch | null {
  const needle = query.trim().toLowerCase()
  if (needle === '') return { score: 0, field: 'name', ranges: [] }
  const haystack = name.toLowerCase()
  if (haystack === needle) return { score: 0, field: 'name', ranges: [[0, name.length]] }
  if (haystack.startsWith(needle)) return { score: 1, field: 'name', ranges: [[0, needle.length]] }
  const at = haystack.indexOf(needle)
  if (at >= 0) return { score: 2 + at / 1000, field: 'name', ranges: [[at, at + needle.length]] }
  const positions: number[] = []
  for (const letter of needle) {
    const found = haystack.indexOf(letter, (positions.at(-1) ?? -1) + 1)
    if (found < 0) break
    positions.push(found)
  }
  if (positions.length === needle.length) {
    const spread = (positions.at(-1) ?? 0) - (positions[0] ?? 0) + 1 - needle.length
    return { score: 3 + Math.min(0.99, spread / 100), field: 'name', ranges: merge(positions) }
  }
  const inDescription = (description ?? '').toLowerCase().indexOf(needle)
  if (inDescription >= 0) return { score: 10 + inDescription / 1000, field: 'description', ranges: [[inDescription, inDescription + needle.length]] }
  return null
}

export type SectionId = 'recent' | 'skills' | 'plugins' | 'commands' | 'builtin'

export interface MenuItem {
  key: string
  command: SlashCommand
  match: FuzzyMatch
}

export interface MenuSection {
  id: SectionId
  label: string
  count: number
  items: MenuItem[]
}

const sectionOf: Record<SlashCommand['source'], Exclude<SectionId, 'recent'>> = { skill: 'skills', plugin: 'plugins', user: 'commands', project: 'commands', builtin: 'builtin' }
const sections: { id: Exclude<SectionId, 'recent'>; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'commands', label: 'Commands' },
  { id: 'builtin', label: 'Built-in' },
]
const recentShown = 5

export function commandKey(command: SlashCommand): string {
  return `${command.source}:${command.name}`
}

/**
 * The commands matching a query in sections with their counts. With nothing typed, a Recent section
 * comes first and the rest keep a fixed order; with a query, the section holding the best match comes
 * first. Inside a section: better match, then more recent, then by name.
 */
export function commandSections(commands: SlashCommand[], query: string, recent: string[], options: { sources?: SlashCommand['source'][] } = {}): MenuSection[] {
  const allowed = options.sources
  const recency = (key: string) => {
    const index = recent.indexOf(key)
    return index < 0 ? Infinity : index
  }
  const matched = commands.flatMap((command): MenuItem[] => {
    if (allowed !== undefined && !allowed.includes(command.source)) return []
    const match = fuzzyMatch(query, command.name, command.description)
    return match === null ? [] : [{ key: commandKey(command), command, match }]
  })
  matched.sort((left, right) => left.match.score - right.match.score || recency(left.key) - recency(right.key) || left.command.name.localeCompare(right.command.name))
  const grouped = sections
    .map((section) => {
      const items = matched.filter((item) => sectionOf[item.command.source] === section.id)
      return { ...section, count: items.length, items }
    })
    .filter((section) => section.count > 0)
  if (query.trim() !== '') return grouped.sort((left, right) => (left.items[0]?.match.score ?? 0) - (right.items[0]?.match.score ?? 0))
  const recentItems = recent.flatMap((key) => matched.filter((item) => item.key === key)).slice(0, recentShown)
  return recentItems.length === 0 ? grouped : [{ id: 'recent', label: 'Recent', count: recentItems.length, items: recentItems }, ...grouped]
}

/** The recent picks with this one first, once, keeping at most `limit`. */
export function rememberPick(recent: string[], key: string, limit = 8): string[] {
  return [key, ...recent.filter((item) => item !== key)].slice(0, limit)
}

export type MenuKey = { type: 'move'; index: number } | { type: 'pick' } | { type: 'close' } | null

/** What a key does in the menu: arrows move round the list, Enter and Tab pick, Escape closes. */
export function menuKey(key: string, count: number, active: number): MenuKey {
  if ((key === 'ArrowDown' || key === 'ArrowUp') && count > 0) return { type: 'move', index: (active + (key === 'ArrowDown' ? 1 : -1) + count) % count }
  if ((key === 'Enter' || key === 'Tab') && count > 0) return { type: 'pick' }
  if (key === 'Escape') return { type: 'close' }
  return null
}
