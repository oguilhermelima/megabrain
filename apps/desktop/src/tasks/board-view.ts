import type { GithubProject, GithubProjectField, GithubProjectItem, GithubProjectView } from '@/api/schema'
import { statusColors } from '@/tasks/board-model'

// What the board computes from a GitHub Projects view: its tabs, the field the columns group by,
// the swimlanes a vertical group makes, the order items sort in, and the chips a card shows for the
// view's visible fields. Pure, so the board, the table and the side panel draw from the same model.

type FieldValue = NonNullable<GithubProjectItem['fieldValues']>[number]

/** The project's saved views in GitHub's order. */
export function projectViews(project: Pick<GithubProject, 'views'>): GithubProjectView[] {
  return [...project.views].sort((a, b) => a.number - b.number)
}

/** The view to show: the remembered one when it still exists, else the first. */
export function shownView(views: readonly GithubProjectView[], remembered: string | undefined): GithubProjectView | null {
  return views.find((view) => view.id === remembered) ?? views[0] ?? null
}

/** An option colour as GitHub's dark theme draws it; gray for one it does not name. */
export function optionColor(color: string): string {
  return (statusColors as Record<string, string>)[color] ?? statusColors.GRAY
}

function fieldNamed(project: Pick<GithubProject, 'fields'>, ref: { id: string; name: string } | undefined): GithubProjectField | null {
  if (ref === undefined) return null
  return project.fields.find((field) => field.id === ref.id) ?? project.fields.find((field) => field.name === ref.name) ?? null
}

const isSelect = (field: GithubProjectField | null): field is GithubProjectField => field !== null && field.dataType === 'SINGLE_SELECT'

/** The single-select field the board's columns group by: the view's group field, else Status; null when there is none. */
export function groupField(project: Pick<GithubProject, 'fields'>, view: GithubProjectView | null): GithubProjectField | null {
  const grouped = fieldNamed(project, view?.groupByFields[0])
  if (isSelect(grouped)) return grouped
  const status = project.fields.find((field) => field.name.toLowerCase() === 'status')
  return isSelect(status ?? null) ? (status ?? null) : null
}

/** The field the view's swimlanes group by, when it has one. */
export function laneField(project: Pick<GithubProject, 'fields'>, view: GithubProjectView | null): GithubProjectField | null {
  return fieldNamed(project, view?.verticalGroupByFields[0])
}

/** An item's value for a field, by name. */
export function fieldValue(item: GithubProjectItem, name: string): FieldValue | undefined {
  return item.fieldValues?.find((entry) => entry.field === name)
}

/** The option an item holds in a single-select field; Status falls back to the item's status. */
export function optionOf(item: GithubProjectItem, field: Pick<GithubProjectField, 'name' | 'options'>): string | null {
  const value = fieldValue(item, field.name)
  if (value?.kind === 'singleSelect') {
    const { optionId, name } = value.value
    return field.options.find((option) => option.id === optionId)?.id ?? field.options.find((option) => option.name === name)?.id ?? null
  }
  if (field.name.toLowerCase() === 'status' && item.status !== null) return field.options.find((option) => option.id === item.status)?.id ?? null
  return null
}

export interface ViewColumn {
  /** The option's id; null for the items with no value. */
  id: string | null
  name: string
  color: string
  description: string
  items: GithubProjectItem[]
}

/** One column per option in the field's order, after No <field> as GitHub draws it; items keep their order. */
export function viewColumns(field: GithubProjectField, items: readonly GithubProjectItem[]): ViewColumn[] {
  const columns: ViewColumn[] = [{ id: null, name: `No ${field.name}`, color: statusColors.GRAY, description: '', items: [] }, ...field.options.map((option) => ({ id: option.id, name: option.name, color: optionColor(option.color), description: option.description, items: [] }))]
  const byId = new Map(columns.map((column) => [column.id, column]))
  for (const item of items) (byId.get(optionOf(item, field)) ?? columns[0])?.items.push(item)
  return columns
}

/** The text a lane groups an item by, for a field that is not a single select; null without a value. */
function laneKey(item: GithubProjectItem, field: GithubProjectField): string | null {
  const value = fieldValue(item, field.name)
  if (value === undefined) return null
  switch (value.kind) {
    case 'iteration':
    case 'milestone':
      return value.value?.title ?? null
    case 'number':
    case 'date':
    case 'text':
    case 'repository':
      return value.value === null ? null : String(value.value)
    default:
      return null
  }
}

export interface Swimlane {
  /** The option id or value; null for the No <field> lane. */
  id: string | null
  name: string
  color: string | null
  items: GithubProjectItem[]
}

/**
 * The view's swimlanes: a single select gives one lane per option in its order, any other field one
 * per value in first-seen order; the items without a value close the list in No <field>. Empty lanes
 * of a single select are kept, as GitHub keeps them.
 */
export function swimlanes(field: GithubProjectField, items: readonly GithubProjectItem[]): Swimlane[] {
  const none: Swimlane = { id: null, name: `No ${field.name}`, color: null, items: [] }
  if (isSelect(field)) {
    const lanes: Swimlane[] = field.options.map((option) => ({ id: option.id, name: option.name, color: optionColor(option.color), items: [] }))
    const byId = new Map(lanes.map((lane) => [lane.id, lane]))
    for (const item of items) (byId.get(optionOf(item, field) ?? '') ?? none).items.push(item)
    return [...lanes, none]
  }
  const byKey = new Map<string, Swimlane>()
  for (const item of items) {
    const key = laneKey(item, field)
    if (key === null) {
      none.items.push(item)
      continue
    }
    const lane = byKey.get(key) ?? { id: key, name: key, color: null, items: [] }
    lane.items.push(item)
    byKey.set(key, lane)
  }
  return [...byKey.values(), none]
}

/** A value to sort by: numbers and dates compare as numbers, option and text values by their order or text. */
function sortKey(item: GithubProjectItem, project: Pick<GithubProject, 'fields'>, name: string): number | string | null {
  const lowered = name.toLowerCase()
  if (lowered === 'title') return item.title.toLowerCase()
  if (lowered === 'updated') return Date.parse(item.updatedAt)
  const field = project.fields.find((entry) => entry.name === name)
  if (field !== undefined && isSelect(field)) {
    const option = optionOf(item, field)
    return option === null ? null : field.options.findIndex((entry) => entry.id === option)
  }
  const value = fieldValue(item, name)
  if (value === undefined) return null
  if (value.kind === 'number') return value.value
  if (value.kind === 'date') return value.value === null ? null : Date.parse(value.value)
  if (value.kind === 'iteration') return Date.parse(value.value.startDate) || value.value.title
  return laneKey(item, field ?? { id: '', name, dataType: '', options: [], iterations: [] })?.toLowerCase() ?? null
}

/** The items in the view's sort order, stable; items without a value go last whatever the direction. */
export function sortedItems(items: readonly GithubProjectItem[], project: Pick<GithubProject, 'fields'>, view: GithubProjectView | null): GithubProjectItem[] {
  const sorts = view?.sortByFields ?? []
  if (sorts.length === 0) return [...items]
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      for (const sort of sorts) {
        const x = sortKey(a.item, project, sort.field.name)
        const y = sortKey(b.item, project, sort.field.name)
        if (x === y) continue
        if (x === null) return 1
        if (y === null) return -1
        const order = x < y ? -1 : 1
        return sort.direction.toUpperCase() === 'DESC' ? -order : order
      }
      return a.index - b.index
    })
    .map((entry) => entry.item)
}

export type CardChip =
  | { kind: 'label'; name: string; color: string }
  | { kind: 'option'; field: string; name: string; color: string }
  | { kind: 'value'; field: string; text: string }
  | { kind: 'assignees'; logins: string[] }

/** Fields a card already shows in its header and title, or as its column and lane. */
const shownElsewhere = new Set(['title', 'repository', 'linked pull requests', 'sub-issues progress', 'parent issue', 'tracks', 'tracked by'])

function shortDate(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * The chips a card shows, one or more per visible field in the view's order: labels in their
 * colours, single-select values in their option's colour, other values compactly, and the assignees
 * last. The field the columns group by and the lane field are left out; a field without a value adds nothing.
 */
export function cardChips(item: GithubProjectItem, project: Pick<GithubProject, 'fields'>, view: GithubProjectView | null, skip: readonly string[] = []): CardChip[] {
  const chips: CardChip[] = []
  let assignees = false
  const visible = view === null || view.visibleFields.length === 0 ? [{ id: '', name: 'Labels' }, { id: '', name: 'Assignees' }] : view.visibleFields
  for (const ref of visible) {
    const name = ref.name
    const lowered = name.toLowerCase()
    if (skip.includes(name) || shownElsewhere.has(lowered)) continue
    if (lowered === 'labels') {
      chips.push(...item.labels.map((label) => ({ kind: 'label' as const, name: label.name, color: label.color })))
      continue
    }
    if (lowered === 'assignees') {
      assignees = item.assignees.length > 0
      continue
    }
    const field = fieldNamed(project, ref)
    if (field !== null && isSelect(field)) {
      const option = field.options.find((entry) => entry.id === optionOf(item, field))
      if (option !== undefined) chips.push({ kind: 'option', field: field.name, name: option.name, color: optionColor(option.color) })
      continue
    }
    const value = fieldValue(item, name)
    if (value === undefined) continue
    const text =
      value.kind === 'number' ? (value.value === null ? null : String(value.value))
      : value.kind === 'date' ? (value.value === null ? null : shortDate(value.value))
      : value.kind === 'text' ? value.value
      : value.kind === 'iteration' ? value.value.title
      : value.kind === 'milestone' ? (value.value?.title ?? null)
      : value.kind === 'users' || value.kind === 'reviewers' ? (value.value.length === 0 ? null : value.value.join(', '))
      : null
    if (text !== null && text !== '') chips.push({ kind: 'value', field: name, text })
  }
  if (assignees) chips.push({ kind: 'assignees', logins: item.assignees.map((assignee) => assignee.login) })
  return chips
}

/** The item as it shows once `field` holds option `optionId`, before GitHub answers. */
export function withOption(item: GithubProjectItem, field: Pick<GithubProjectField, 'name' | 'options'>, optionId: string): GithubProjectItem {
  const name = field.options.find((option) => option.id === optionId)?.name ?? null
  const fieldValues: FieldValue[] = [...(item.fieldValues ?? []).filter((entry) => entry.field !== field.name), { kind: 'singleSelect', field: field.name, value: { optionId, name } }]
  return { ...item, fieldValues, ...(field.name.toLowerCase() === 'status' ? { status: optionId } : {}) }
}

export interface PendingEdit {
  /** Tells edits apart, so an answer settles its own. */
  id: number
  itemId: string
  field: Pick<GithubProjectField, 'name' | 'options'>
  optionId: string
}

/** The items as the board shows them: each pending edit applied in the order made. */
export function editedItems(items: readonly GithubProjectItem[], pending: readonly PendingEdit[]): GithubProjectItem[] {
  if (pending.length === 0) return [...items]
  return items.map((item) => pending.reduce((shown, edit) => (edit.itemId === item.id ? withOption(shown, edit.field, edit.optionId) : shown), item))
}

/** What a line typed under a column adds: an issue or pull request by URL or owner/repo#number, else a draft titled with it. */
export function parseAddition(text: string): { kind: 'reference'; reference: string } | { kind: 'draft'; title: string } | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+\/?$/.test(trimmed) || /^[\w.-]+\/[\w.-]+#\d+$/.test(trimmed)) return { kind: 'reference', reference: trimmed }
  return { kind: 'draft', title: trimmed }
}

/** The field types `githubProjectSetField` writes, by GitHub's data type; null for one the app cannot edit. */
export function editableType(field: Pick<GithubProjectField, 'dataType'>): 'single-select' | 'number' | 'date' | 'text' | 'iteration' | null {
  switch (field.dataType) {
    case 'SINGLE_SELECT':
      return 'single-select'
    case 'NUMBER':
      return 'number'
    case 'DATE':
      return 'date'
    case 'TEXT':
      return 'text'
    case 'ITERATION':
      return 'iteration'
    default:
      return null
  }
}

/** The last view shown per project, kept per viewer; storage may be missing or full, which only forgets. */
export function readViewPrefs(storage: () => Storage): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(storage().getItem('tasks.board.views') ?? '{}')
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

export function writeViewPrefs(storage: () => Storage, prefs: Record<string, string>): void {
  try {
    storage().setItem('tasks.board.views', JSON.stringify(prefs))
  } catch {
    // Forgetting the view is all a failed write costs.
  }
}
