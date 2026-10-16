// Scrolling a pane into view moves with the motion tokens (styles.css). A scroll offset is no CSS
// property, so the curve is evaluated here, for a requestAnimationFrame loop.

/** The CSS cubic-bezier(x1, y1, x2, y2) timing function, as progress for a time share between 0 and 1. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (a: number, b: number, s: number) => 3 * a * (1 - s) * (1 - s) * s + 3 * b * (1 - s) * s * s + s * s * s
  const slope = (a: number, b: number, s: number) => 3 * a * (1 - s) * (1 - s) + 6 * (b - a) * (1 - s) * s + 3 * (1 - b) * s * s
  return (t) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    // Find the curve parameter whose x is t: Newton's method, then bisection when the slope is flat.
    let s = t
    for (let step = 0; step < 8; step++) {
      const error = at(x1, x2, s) - t
      const d = slope(x1, x2, s)
      if (Math.abs(error) < 1e-7) return at(y1, y2, s)
      if (Math.abs(d) < 1e-6) break
      s -= error / d
    }
    let low = 0
    let high = 1
    s = t
    for (let step = 0; step < 40; step++) {
      const x = at(x1, x2, s)
      if (Math.abs(x - t) < 1e-7) break
      if (x < t) low = s
      else high = s
      s = (low + high) / 2
    }
    return at(y1, y2, s)
  }
}

const linear = (t: number) => Math.max(0, Math.min(1, t))

/** A duration token (240ms, 0.3s) and an easing token (cubic-bezier(...)); anything else is no motion, or a linear curve. */
export function readMotion(duration: string, ease: string): { ms: number; ease: (t: number) => number } {
  const time = /^\s*([\d.]+)(ms|s)\s*$/.exec(duration)
  const value = time === null ? 0 : Number(time[1]) * (time[2] === 's' ? 1000 : 1)
  const curve = /^\s*cubic-bezier\(([^)]*)\)\s*$/.exec(ease)
  const points = curve === null ? [] : (curve[1] ?? '').split(',').map((part) => Number(part.trim()))
  const [x1, y1, x2, y2] = points
  const valid = points.length === 4 && points.every(Number.isFinite) && x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined
  return { ms: Number.isFinite(value) ? value : 0, ease: valid ? cubicBezier(x1, y1, x2, y2) : linear }
}

/** The panel motion as the document's tokens give it now (0 under reduced motion). */
export function panelMotion() {
  const style = getComputedStyle(document.documentElement)
  return readMotion(style.getPropertyValue('--motion-panel'), style.getPropertyValue('--motion-ease-panel'))
}
