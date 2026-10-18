import { useState } from 'react'
import type { ChatApproval } from '@/api/schema'
import { ErrorNote, Spinner } from '@/components/ui'

export type ApprovalDecision = ChatApproval['decisions'][number]

const decisionLabel: Record<ApprovalDecision, string> = { allow: 'Allow', 'allow-session': 'Allow for this session', deny: 'Deny' }
const decisionStyle: Record<ApprovalDecision, string> = {
  allow: 'bg-accent text-accent-ink hover:bg-[#a3aeff]',
  'allow-session': 'border border-white/15 bg-white/[0.07] text-ink-100 hover:bg-white/[0.12]',
  deny: 'border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20',
}

/** What the agent asks to run, why, and the answers it accepts; settled once answered or moved past. */
export function ApprovalCard({ approval, pending, onAnswer }: { approval: ChatApproval; pending: boolean; onAnswer: (decision: ApprovalDecision) => Promise<void> }) {
  const [answering, setAnswering] = useState<ApprovalDecision | null>(null)
  const [error, setError] = useState<unknown>(null)

  const answer = (decision: ApprovalDecision) => {
    setAnswering(decision)
    setError(null)
    onAnswer(decision).then(
      () => setAnswering(null),
      (caught: unknown) => {
        setAnswering(null)
        setError(caught)
      },
    )
  }

  return (
    <div className={`max-w-[85%] rounded-[20px] border px-4 py-3.5 ${pending ? 'border-warn/30 bg-warn/[0.06]' : 'border-white/[0.06] bg-white/[0.03]'}`}>
      <p className="text-chat-ui text-ink-300">
        <span className={`font-semibold ${pending ? 'text-warn' : 'text-ink-300'}`}>{pending ? 'Approval needed' : 'Approval'}</span>
        <span className="text-ink-400"> · </span>
        <span className="font-semibold text-ink-100">{approval.tool}</span>
      </p>
      <pre className="mt-2 max-h-48 overflow-y-auto rounded-xl bg-white/[0.05] px-3 py-2 font-mono text-chat-code whitespace-pre-wrap text-ink-200 select-text">{approval.input}</pre>
      {approval.reason !== undefined && approval.reason !== null && approval.reason !== '' && <p className="mt-2 text-chat-ui text-ink-300">{approval.reason}</p>}
      {pending && (
        <div className="mt-3 flex flex-wrap gap-2">
          {approval.decisions.map((decision) => (
            <button
              key={decision}
              type="button"
              disabled={answering !== null}
              onClick={() => answer(decision)}
              className={`inline-flex h-8 items-center gap-2 rounded-full px-4 text-chat-ui font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${decisionStyle[decision]}`}
            >
              {answering === decision && <Spinner />}
              {decisionLabel[decision]}
            </button>
          ))}
        </div>
      )}
      {error !== null && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  )
}
