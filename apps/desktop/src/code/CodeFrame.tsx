import { useEffect, useState } from 'react'
import { api } from '@/api'
import { Button, ErrorNote, Spinner } from '@/components/ui'
import { frameFadeMs, frameRevealDelay, type CodeTarget } from '@/code/code-mode-model'

// One root's VS Code, edge to edge. The frame and everything behind it paint the app's dark
// surface, and the frame fades in only after its workbench has had time to paint its theme
// (see frameRevealDelay), so starting never flashes white. It stays
// mounted, hidden, while the person is in chats or another root; the server is stopped only when
// the root is closed (see closeCode), never when the frame goes out of sight.
/** A file to show once VS Code is up; a new request object asks again for the same file. */
// The roots whose workbench has painted in this app session: a later open reveals sooner.
const painted = new Set<string>()

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
  // window for VS Code to reuse.
  useEffect(() => {
    if (goto === null || !loaded) return
    setGotoError(null)
    api.openInCode(root, goto.path, goto.line ?? undefined).catch(setGotoError)
  }, [root, goto, loaded])

  return (
    <div hidden={!visible} className="absolute inset-0 bg-ink-950">
      {url !== null && (
        <iframe
          title={`VS Code for ${title}`}
          src={url}
          onLoad={() => setLoaded(true)}
          style={{ transitionDuration: `${frameFadeMs}ms` }}
          className={`size-full border-0 bg-ink-950 transition-opacity ${revealed ? 'opacity-100' : 'opacity-0'}`}
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
            <Spinner /> Starting VS Code for {title}…
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
