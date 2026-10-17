// WCAG 2 contrast between two opaque colours, for checking the app's text tokens against the
// surfaces they sit on. Colours are #rrggbb.

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function luminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((channel) => {
    const linear = channel / 255
    return linear <= 0.03928 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/** From 1 (the same) to 21 (black on white); text needs 4.5 for WCAG AA. */
export function contrastRatio(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

/** A colour laid over another at a share from 0 to 1, as a translucent fill paints it. */
export function blend(top: string, bottom: string, alpha: number): string {
  const [upper, lower] = [channels(top), channels(bottom)]
  return `#${upper.map((channel, index) => Math.round(channel * alpha + (lower[index] ?? 0) * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}
