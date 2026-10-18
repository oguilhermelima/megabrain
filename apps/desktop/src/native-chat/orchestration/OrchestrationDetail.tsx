import { useEffect, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { OpenChat } from '@/chat/Conversation'
import { AgentIcon } from '@/components/agent-icons'
import { MenuIconGlyph, type MenuIcon } from '@/components/menu-icons'
import { Tooltip } from '@/components/Tooltip'
import { ErrorNote } from '@/components/ui'
import { StateChip } from '@/native-chat/orchestration/OrchestrationCard'
import { OrchestrationNodeChat } from '@/native-chat/orchestration/OrchestrationNodeChat'
import { dispatchOf } from '@/native-chat/orchestration/orchestration-layout'
import type { OrchestrationNode } from '@/api/schema'

function IconAction({ icon, label, pressed, onClick }: { icon: MenuIcon; label: string; pressed?: boolean; onClick: () => void }) {
  return (
    <Tooltip text={label}>
      {(anchor) => (
        <button
          type="button"
          {...anchor}
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className={`grid size-7 shrink-0 place-items-center rounded-full ${pressed === true ? 'bg-white/[0.12] text-ink-100' : 'text-ink-400 hover:bg-white/[0.07] hover:text-ink-100'}`}
        >
          <MenuIconGlyph icon={icon} />
        </button>
      )}
    </Tooltip>
  )
}

const Meta = ({ children }: { children: ReactNode }) => <span className="min-w-0 truncate font-mono text-chat-label text-ink-400 select-text">{children}</span>

/**
 * The selected node as a chat: who it is (agent, model, state, branch and commits) on top with its
 * actions as icons, and its conversation under it. Read terminal swaps the conversation for the
 * lane's terminal readout until pressed again.
 */
export function OrchestrationDetail({ node, onOpen, onOpenChat, onClose }: { node: OrchestrationNode; onOpen: (() => void) | null; onOpenChat?: OpenChat; onClose: () => void }) {
  const dispatch = dispatchOf(node)
  const [terminal, setTerminal] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    setTerminal(null)
    setError(null)
  }, [node.id])

  const toggleTerminal = () => {
    if (dispatch === null) return
    if (terminal !== null) return setTerminal(null)
    setError(null)
    api.readChat(dispatch, 200).then((read) => setTerminal(read.text || '(no output yet)'), setError)
  }

  const model = [node.model, node.effort].filter((part) => part !== null).join(' · ')
  const branch = node.branch === null ? null : node.commits === null ? node.branch : `${node.branch} · ${node.commits === 1 ? '1 commit' : `${node.commits} commits`}`
  return (
    <aside aria-label={`${node.label} chat`} className="flex min-h-0 flex-1 flex-col bg-ink-900">
      <header className="flex flex-col gap-1 border-b border-white/[0.07] px-4 pt-3 pb-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <AgentIcon agent={node.agent} />
          <h3 className="min-w-0 flex-1 truncate text-chat-ui font-semibold text-ink-100" title={node.label}>
            {node.label}
          </h3>
          <StateChip state={node.state} />
          {dispatch !== null && <IconAction icon="terminal" label={terminal === null ? 'Read terminal' : 'Back to the chat'} pressed={terminal !== null} onClick={toggleTerminal} />}
          {onOpen !== null && <IconAction icon="external" label="Open chat" onClick={onOpen} />}
          <IconAction icon="close" label="Close" onClick={onClose} />
        </div>
        {(model !== '' || branch !== null) && (
          <div className="flex min-w-0 items-center gap-3 pl-7">
            {model !== '' && <Meta>{model}</Meta>}
            {branch !== null && <Meta>{branch}</Meta>}
          </div>
        )}
        {node.unanswered && <p className="pl-7 text-chat-small font-semibold text-warn">Waiting for an answer from its coordinator.</p>}
        {node.finding !== null && <p className="pl-7 text-chat-small text-warn">{node.finding}</p>}
      </header>
      {error !== null && (
        <div className="px-4 pt-3">
          <ErrorNote error={error} />
        </div>
      )}
      {terminal !== null ? (
        <pre className="m-4 min-h-0 flex-1 overflow-auto rounded-[14px] border border-white/[0.06] bg-[#050506] px-3 py-2 font-mono text-chat-label leading-[1.6] whitespace-pre text-ink-300 select-text">{terminal}</pre>
      ) : (
        <OrchestrationNodeChat key={node.id} node={node} onOpenChat={onOpenChat} />
      )}
    </aside>
  )
}
