// The model picker's text colours, in one place so chat/model-picker-look.test.ts can hold each to
// WCAG AA against the popover's surface (ink-900) and the selected row's tint. No ink-500 and no
// faded colour: those read as grey smudges on the dark panel.

/** The popover's background token (styles.css .popover). */
export const pickerSurface = 'ink-900'

/** The selected row's fill: the accent at this share over the surface. */
export const selectedTint = { token: 'accent', alpha: 0.14 } as const

export const pickerText = {
  heading: 'text-ink-400',
  name: 'text-ink-100',
  hint: 'text-ink-300',
  selectedName: 'text-ink-100',
  selectedHint: 'text-ink-200',
  olderToggle: 'text-ink-400',
  segment: 'text-ink-300',
  effortLabel: 'text-ink-300',
  effortHint: 'text-ink-300',
} as const
