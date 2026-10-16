/**
 * Where each pane wants its VS Code: the element a pane in Code view leaves empty under its top
 * bar, by item. Frames never move between parents (moving an iframe reloads it), so the code layer
 * lays each one over its slot instead and listens here for slots that come and go.
 */
export interface CodeSlots {
  set(item: string, element: HTMLElement | null): void
  get(item: string): HTMLElement | undefined
  elements(): HTMLElement[]
  subscribe(listener: () => void): () => void
}

export function createCodeSlots(): CodeSlots {
  const slots = new Map<string, HTMLElement>()
  const listeners = new Set<() => void>()
  return {
    set(item, element) {
      if (element === null ? !slots.delete(item) : slots.get(item) === element) return
      if (element !== null) slots.set(item, element)
      for (const listener of listeners) listener()
    },
    get: (item) => slots.get(item),
    elements: () => [...slots.values()],
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
