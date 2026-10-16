// What a multi-select dropdown lists and says: options in groups, some folded away as older, a
// search over them, and the one line the closed button shows.

export interface PickOption {
  value: string
  label: string
  /** A second, smaller line: a model's id. */
  detail?: string
}

export interface PickGroup {
  /** A heading over the group; none for a flat list. */
  label?: string
  options: PickOption[]
  /** Folded away under "Older" until opened or searched. */
  older?: PickOption[]
}

const allOptions = (groups: PickGroup[]) => groups.flatMap((group) => [...group.options, ...(group.older ?? [])])

/** The list with `value` turned on or off; a value turned on goes last. */
export function toggledValue(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

/** The chosen values by label, a value no group lists as itself. */
export function chosenLabels(chosen: string[], groups: PickGroup[]): string[] {
  const options = allOptions(groups)
  return chosen.map((value) => options.find((option) => option.value === value)?.label ?? value)
}

/** What the closed dropdown says: `any` for nothing chosen, one or two labels by name, else how many. */
export function selectionSummary(chosen: string[], groups: PickGroup[], plural: string, any = 'Any'): string {
  if (chosen.length === 0) return any
  if (chosen.length > 2) return `${chosen.length} ${plural}`
  return chosenLabels(chosen, groups).join(', ')
}

/** Chosen values no group lists (an older model, a typo in chains.json), in a group of their own so they can be turned off. */
export function withUnknown(groups: PickGroup[], chosen: string[], label = 'Not in the registry'): PickGroup[] {
  const known = new Set(allOptions(groups).map((option) => option.value))
  const unknown = chosen.filter((value) => !known.has(value))
  return unknown.length === 0 ? groups : [...groups, { label, options: unknown.map((value) => ({ value, label: value })) }]
}

/** The options whose label, value or detail holds the query, any case; a search opens the older ones too and drops empty groups. */
export function filterGroups(groups: PickGroup[], query: string): PickGroup[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return groups
  const hit = (option: PickOption) => [option.label, option.value, option.detail ?? ''].some((text) => text.toLowerCase().includes(needle))
  return groups.map((group) => ({ label: group.label, options: [...group.options, ...(group.older ?? [])].filter(hit) })).filter((group) => group.options.length > 0)
}

/** How many options the groups hold, folded ones included. */
export function optionCount(groups: PickGroup[]): number {
  return allOptions(groups).length
}
