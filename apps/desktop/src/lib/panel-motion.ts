// While the sidebar or the run panel slides open or shut, the main area changes width every frame. A
// terminal that refitted on each of those frames would resize its process dozens of times, so it
// waits for the panels to settle and refits once.

type Listener = () => void

let moving = 0
const settled = new Set<Listener>()

/** A panel starts moving; call the returned function, once, when it stops. */
export function startPanelMotion(): () => void {
  moving += 1
  let ended = false
  return () => {
    if (ended) return
    ended = true
    moving -= 1
    if (moving === 0) for (const listener of [...settled]) listener()
  }
}

export function panelsMoving(): boolean {
  return moving > 0
}

/** Called each time the last moving panel stops. */
export function onPanelsSettled(listener: Listener): () => void {
  settled.add(listener)
  return () => settled.delete(listener)
}
