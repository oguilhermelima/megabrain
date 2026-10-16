// Background work cut into slices of a few milliseconds, run when the main thread is idle, so a
// long job (colouring a 20000-line diff) never holds a frame. A task does a little and returns
// true once it is finished; it is called again on the next slice until then.

export type IdleTask = (timeLeft: () => number) => boolean

/** Longest a slice runs before yielding back to input and rendering. */
const sliceMs = 6

const tasks = new Set<IdleTask>()
let scheduled = false

const requestIdle: (run: () => void) => void =
  typeof requestIdleCallback === 'function' ? (run) => requestIdleCallback(run, { timeout: 120 }) : (run) => setTimeout(run, 0)

function slice() {
  scheduled = false
  const end = performance.now() + sliceMs
  const timeLeft = () => end - performance.now()
  for (const task of tasks) {
    if (timeLeft() <= 0) break
    if (task(timeLeft)) tasks.delete(task)
  }
  if (tasks.size > 0) schedule()
}

function schedule() {
  if (scheduled) return
  scheduled = true
  requestIdle(slice)
}

/** Queues a task; the returned function drops it, finished or not. */
export function runWhenIdle(task: IdleTask): () => void {
  tasks.add(task)
  schedule()
  return () => {
    tasks.delete(task)
  }
}
