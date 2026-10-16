// What a checkbox shows and what a click makes of it, apart from the DOM.

export type CheckboxMark = 'checked' | 'unchecked' | 'indeterminate'

/** Indeterminate wins: a mixed box says so whatever checked holds underneath. */
export function checkboxMark(checked: boolean, indeterminate = false): CheckboxMark {
  if (indeterminate) return 'indeterminate'
  return checked ? 'checked' : 'unchecked'
}

export function ariaChecked(mark: CheckboxMark): 'true' | 'false' | 'mixed' {
  if (mark === 'indeterminate') return 'mixed'
  return mark === 'checked' ? 'true' : 'false'
}

/** The value a click asks for: a mixed box becomes checked, a plain one flips. */
export function toggled(mark: CheckboxMark): boolean {
  return mark !== 'checked'
}
