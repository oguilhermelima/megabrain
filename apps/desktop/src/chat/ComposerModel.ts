import { useState } from 'react'
import type { MessagePart } from '@/api/schema'
import { sessionCommand, withContextWindow } from '@/chat/composer-status'
import type { ModelPick } from '@/chat/ComposerStatus'
import { switchNotice, type Notice } from '@/chat/composer-look'

export function useComposerModel({ agent, model, context, onModelChange, onSend, show, onSent }: {
  agent: string | null
  model: string | null
  context?: { tokens?: number | null; window?: number | null }
  onModelChange?: (model: string, effort: string | undefined) => Promise<void>
  onSend: (parts: MessagePart[]) => Promise<Notice | null>
  show: (next: Notice | null) => void
  onSent: () => void
}) {
  // The last switch made here: the effort, which the chat record does not carry, and for a session
  // switched by command the model, shown until the session reports a model of its own.
  const [chosen, setChosen] = useState<{ model: string; effort: string | undefined; base: string | null; byCommand: boolean } | null>(null)
  const sameModel = (left: string, right: string) => withContextWindow(left, 'standard') === withContextWindow(right, 'standard')
  const overridden = chosen !== null && chosen.byCommand && chosen.base === model
  const shownModel = overridden ? chosen.model : model
  const shownEffort = chosen !== null && shownModel !== null && sameModel(chosen.model, shownModel) ? chosen.effort : undefined
  // The session's own window belongs to the model it reported, not to one switched to since.
  const shownContext = overridden ? { tokens: context?.tokens, window: null } : context

  const pickModel = ({ model: picked, window, effort }: ModelPick) => {
    if (onModelChange !== undefined) {
      onModelChange(picked, effort).then(
        () => setChosen({ model: picked, effort, base: model, byCommand: false }),
        (error: unknown) => show({ tone: 'bad', text: error instanceof Error ? error.message : String(error) }),
      )
      return
    }
    // Only the agent itself switches a session it runs: /model, or /effort when only the effort
    // changes, goes as a message of its own, through the same path as a reply, and leaves the draft alone.
    const command = sessionCommand(agent, shownModel, { model: picked, window, effort })
    if (command === null) return
    onSend([{ type: 'text', text: command }]).then(
      (result) => {
        const ok = result === null || result.tone === 'ok'
        if (ok) setChosen({ model: picked, effort, base: model, byCommand: picked !== model })
        show(switchNotice(result))
        onSent()
      },
      (error: unknown) => show({ tone: 'bad', text: error instanceof Error ? error.message : String(error) }),
    )
  }

  return { shownModel, shownEffort, shownContext, pickModel }
}
