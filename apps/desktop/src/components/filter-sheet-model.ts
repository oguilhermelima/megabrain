// What a page's filter sheet holds, apart from the DOM: a select per filter, whose first option is the
// one that filters nothing, and switches. A switch marked as a setting (Show No status) changes the
// view rather than narrowing it, so it is never counted, shown as a chip or cleared.
// Clear calls several fields' onChange in a row, so each must apply to the latest state (a functional
// update), never to the state the fields were built from.

export type SheetOption = { value: string; label: string }

export type SheetField =
  | { kind: 'select'; label: string; value: string; options: SheetOption[]; onChange: (value: string) => void }
  | { kind: 'switch'; label: string; on: boolean; onChange: (on: boolean) => void; setting?: boolean }

export function isActive(field: SheetField): boolean {
  if (field.kind === 'switch') return field.on && field.setting !== true
  return field.options.length > 0 && field.value !== field.options[0]?.value
}

/** The number on the Filter button: the filters set. */
export const activeCount = (fields: readonly SheetField[]): number => fields.filter(isActive).length

/** A set filter as its chip reads: "Label: bug", or a switch's own name. */
export function chipLabel(field: SheetField): string {
  if (field.kind === 'switch') return field.label
  return `${field.label}: ${field.options.find((option) => option.value === field.value)?.label ?? field.value}`
}

/** Puts a filter back to filtering nothing. */
export function clearField(field: SheetField): void {
  if (field.kind === 'switch') field.onChange(false)
  else if (field.options[0] !== undefined) field.onChange(field.options[0].value)
}

/** Clears every set filter, leaving settings as they are. */
export function clearAll(fields: readonly SheetField[]): void {
  for (const field of fields) if (isActive(field)) clearField(field)
}

/** Options for the "updated within" filter some pages share; the value is in days, "" is any time. */
export const updatedWithinOptions: SheetOption[] = [
  { value: '', label: 'Any time' },
  { value: '1', label: 'Past day' },
  { value: '7', label: 'Past week' },
  { value: '30', label: 'Past month' },
  { value: '90', label: 'Past 3 months' },
]

/** Whether a timestamp falls within the chosen number of days before now; "" lets everything through. */
export function updatedWithin(at: string, days: string, now: number): boolean {
  if (days === '') return true
  const time = Date.parse(at)
  return Number.isFinite(time) && now - time <= Number(days) * 86_400_000
}
