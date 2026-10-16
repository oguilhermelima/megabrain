/** True when a press lands outside the open panel and outside the button that opened it. */
export function pressedOutside<T>(target: T | null, panel: { contains: (target: T) => boolean } | null, trigger: { contains: (target: T) => boolean } | null): boolean {
  if (target === null || panel === null) return true
  return !panel.contains(target) && trigger?.contains(target) !== true
}
