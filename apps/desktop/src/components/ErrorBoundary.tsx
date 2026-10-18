import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui'
import { caughtError, errorDetails, reportCaught, type CaughtError } from '@/components/error-report'

// One throwing view must never blank the window: React unmounts everything up to the nearest error
// boundary, and without one that is the whole tree. The app root has one, so a crash there leaves a
// recover screen; each pane has its own, so a broken pane shows its error and the rest keeps working.

interface BoundaryProps {
  where: CaughtError['where']
  item?: string | null
  fallback: (caught: CaughtError, retry: () => void) => ReactNode
  children: ReactNode
}

interface BoundaryState {
  /** Boxed, since anything can be thrown, null and undefined included. */
  thrown: { error: unknown } | null
  /** The full record, once componentDidCatch has React's component stack. */
  caught: CaughtError | null
}

export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { thrown: null, caught: null }

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { thrown: { error } }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const caught = caughtError(this.props.where, this.props.item ?? null, error, info.componentStack)
    this.setState({ caught })
    reportCaught(caught)
  }

  retry = () => this.setState({ thrown: null, caught: null })

  render() {
    const { thrown, caught } = this.state
    if (thrown === null) return this.props.children
    return this.props.fallback(caught ?? caughtError(this.props.where, this.props.item ?? null, thrown.error, null), this.retry)
  }
}

function CopyDetails({ caught }: { caught: CaughtError }) {
  const [copied, setCopied] = useState(false)
  const copy = () => void navigator.clipboard.writeText(errorDetails(caught)).then(() => setCopied(true), () => {})
  return <Button onClick={copy}>{copied ? 'Copied' : 'Copy details'}</Button>
}

/** The whole app failed to render: the error, and a way back. */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      where="app"
      fallback={(caught) => (
        <div role="alert" className="flex h-screen flex-col items-center justify-center gap-5 bg-ink-950 px-8 text-center">
          <div data-tauri-drag-region className="fixed inset-x-0 top-0 h-10" />
          <h1 className="text-[18px] font-semibold text-ink-100">Something broke while drawing the window</h1>
          <p className="max-w-[560px] text-[13.5px] text-ink-400">Your chats and terminals keep running. Reload to bring the window back; copy the details to report it.</p>
          <pre className="max-h-[40vh] w-full max-w-[720px] overflow-auto rounded-2xl border border-bad/30 bg-bad/10 px-4 py-3 text-left text-[12.5px] whitespace-pre-wrap text-bad select-text">{`${caught.name}: ${caught.message}`}</pre>
          <div className="flex gap-3">
            <Button variant="primary" onClick={() => window.location.reload()}>Reload</Button>
            <CopyDetails caught={caught} />
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}

/** One pane failed to render: its error inline, with Retry and, in a split, Close pane; the other panes keep working. */
export function PaneErrorBoundary({ item, onClose, children }: { item: string; onClose: (() => void) | null; children: ReactNode }) {
  return (
    <ErrorBoundary
      where="pane"
      item={item}
      fallback={(caught, retry) => (
        <div role="alert" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto px-6 py-6 text-center">
          <p className="text-[14px] font-semibold text-ink-100">This pane hit an error</p>
          <pre className="max-h-48 w-full max-w-[560px] overflow-auto rounded-2xl border border-bad/30 bg-bad/10 px-4 py-3 text-left text-[12.5px] whitespace-pre-wrap text-bad select-text">{`${caught.name}: ${caught.message}`}</pre>
          <div className="flex flex-wrap justify-center gap-3">
            <Button onClick={retry}>Retry</Button>
            {onClose !== null && <Button onClick={onClose}>Close pane</Button>}
            <CopyDetails caught={caught} />
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
