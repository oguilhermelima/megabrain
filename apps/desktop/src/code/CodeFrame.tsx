import { useEffect, useState } from 'react'
import { api } from '@/api'
import { Button, ErrorNote, Spinner } from '@/components/ui'
import { frameFadeMs, frameRevealDelay, type CodeTarget } from '@/code/code-pane-model'

// One root's Code, filling the box the code layer gives it. The frame and everything behind it
// paint the app's dark surface, and the frame fades in only after its workbench has had time to
// paint its theme (see frameRevealDelay), so starting never flashes white. It stays mounted,
// hidden, while no pane shows it in Code; its server stops only after its grace (see
// expiredServers), never when the frame goes out of sight.
// The roots whose workbench has painted in this app session: a later open reveals sooner.
const painted = new Set<string>()

/** The workbench's title bar, in CSS pixels: with the activity bar on top code-server 4.138.0
 * always draws it, 30px tall with no command center (see CODE_ENFORCED_SETTINGS). The frame is
 * that much taller than its box and starts that much above it, so the bar is cropped off while the
 * workbench still lays out at full height: nothing below it moves and no band is left empty.
 * Measured headlessly against the real workbench; re-measure when the pinned version changes. */
const titleBarCrop = 30

/** A file to show once Code is up; a new request object asks again for the same file. */
export interface CodeGoto {
  path: string
  line: number | null
}

export function CodeFrame({ target, visible, goto }: { target: CodeTarget; visible: boolean; goto: CodeGoto | null }) {
  const { root, title } = target
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loaded, setLoaded] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [gotoError, setGotoError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setError(null)
    setLoaded(false)
    setRevealed(false)
    api
      .openCodeServer(root)
      .then((server) => {
        // Closed while it was starting: the stop sent on close may have arrived first.
        if (cancelled) void api.stopCodeServer(root).catch(() => {})
        else setUrl(server.url)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught)
      })
    return () => {
      cancelled = true
    }
  }, [root, retry])

  useEffect(() => {
    if (!loaded) return
    const timer = setTimeout(() => {
      painted.add(root)
      setRevealed(true)
    }, frameRevealDelay(painted, root))
    return () => clearTimeout(timer)
  }, [root, loaded])

  // A file asked for from a chat opens once the workbench has loaded: before that there is no
  // window for Code to reuse.
  useEffect(() => {
    if (goto === null || !loaded) return
    setGotoError(null)
    api.openInCode(root, goto.path, goto.line ?? undefined).catch(setGotoError)
  }, [root, goto, loaded])

  return (
    <div hidden={!visible} className="absolute inset-0 overflow-hidden bg-transparent">
      {url !== null && (
        <iframe
          title={`Code for ${title}`}
          src={url}
          onLoad={() => setLoaded(true)}
          style={{ transitionDuration: `${frameFadeMs}ms`, top: -titleBarCrop, height: `calc(100% + ${titleBarCrop}px)` }}
          className={`absolute inset-x-0 w-full border-0 bg-transparent transition-opacity ${revealed ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
      {error !== null ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <ErrorNote error={error} />
          <Button variant="ghost" onClick={() => setRetry((current) => current + 1)}>Try again</Button>
        </div>
      ) : (
        !revealed && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-[13px] text-ink-400" role="status" aria-live="polite">
            <Spinner /> Starting Code for {title}…
          </div>
        )
      )}
      {gotoError !== null && (
        <div className="absolute right-4 bottom-4 left-4 flex items-start gap-2 rounded-[16px] border border-white/[0.1] bg-ink-900 p-3 shadow-2xl">
          <div className="min-w-0 flex-1">
            <ErrorNote error={gotoError} />
          </div>
          <Button variant="ghost" onClick={() => setGotoError(null)}>Dismiss</Button>
        </div>
      )}
    </div>
  )
}
