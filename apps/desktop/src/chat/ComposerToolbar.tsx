import type { Dispatch, RefObject, SetStateAction } from 'react'
import { Spinner } from '@/components/ui'
import { Tooltip } from '@/components/Tooltip'
import { ComposerStatus, type ModelPick } from '@/chat/ComposerStatus'
import { SkillMenu } from '@/chat/SkillMenu'
import type { SlashCommand } from '@/api/schema'
import type { AnchorRect } from '@/advanced/menu-placement'
import type { SendState } from '@/chat/composer-look'

const ghost = 'grid size-8 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.07] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'

export function ComposerToolbar({ picker, disabled, agent, hasSkills, skillAnchor, setSkillAnchor, skillMenu, commands, recent, pickSkill, closeSkills, shownContext, shownModel, shownEffort, canSetEffort, pickModel, dictation, button, onStop, send, onAttachFiles }: {
  picker: RefObject<HTMLInputElement | null>
  disabled: boolean
  agent: string | null
  hasSkills: boolean
  skillAnchor: AnchorRect | null
  setSkillAnchor: Dispatch<SetStateAction<AnchorRect | null>>
  skillMenu: { shown: AnchorRect | null; leaving: boolean }
  commands: SlashCommand[]
  recent: string[]
  pickSkill: (command: SlashCommand) => void
  closeSkills: () => void
  shownContext: { tokens?: number | null; window?: number | null } | undefined
  shownModel: string | null
  shownEffort: string | undefined
  canSetEffort: boolean
  pickModel: (pick: ModelPick) => void
  dictation: { supported: boolean; listening: boolean; toggle: () => void }
  button: SendState
  onStop?: () => void
  send: () => void
  onAttachFiles: (files: File[]) => void
}) {
  const sendLabel = button === 'sending' ? 'Sending' : button === 'stop' ? 'Stop the turn (Esc)' : button === 'ready' ? 'Send (Enter)' : 'Send'
  return (
    // Inside the card: the first ghost button's fill overhangs the box's text inset by its glyph's 8px, so the glyph starts on it.
    <div className="flex min-w-0 items-center gap-1 px-2 pt-1 pb-2">
      <Tooltip text="Attach images or PDFs">
        {(tip) => (
          <button type="button" {...tip} onClick={() => picker.current?.click()} disabled={disabled} aria-label="Attach images or PDFs" className={ghost}>
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.4 11.6-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" /></svg>
          </button>
        )}
      </Tooltip>
      <Tooltip text={hasSkills ? 'Use a skill' : `${agent ?? 'This agent'} has no skills here`}>
        {(tip) => (
          <span {...tip} className="shrink-0">
            <button type="button" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setSkillAnchor((open) => (open === null ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null)) }} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation() }} disabled={disabled || !hasSkills} aria-label="Skills" aria-expanded={skillAnchor !== null} className={`${ghost} aria-expanded:bg-white/[0.08] aria-expanded:text-ink-100`}>
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></svg>
            </button>
          </span>
        )}
      </Tooltip>
      {skillMenu.shown !== null && <SkillMenu anchor={skillMenu.shown} commands={commands} recent={recent} leaving={skillMenu.leaving} onPick={pickSkill} onClose={closeSkills} />}
      <input ref={picker} type="file" accept="image/*,application/pdf" multiple hidden onChange={(event) => { onAttachFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = '' }} />
      <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-white/[0.08]" />
      <ComposerStatus agent={agent} context={shownContext} model={shownModel} effort={shownEffort} canSetEffort={canSetEffort} onPickModel={pickModel} />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {dictation.supported && (
          <Tooltip text={dictation.listening ? 'Stop dictation' : 'Dictate'}>
            {(tip) => (
              <button type="button" {...tip} onClick={dictation.toggle} disabled={disabled} aria-pressed={dictation.listening} aria-label={dictation.listening ? 'Stop dictation' : 'Dictate'} className={dictation.listening ? `${ghost} bg-bad/[0.15] text-bad hover:bg-bad/[0.2] hover:text-bad` : ghost}>
                <svg viewBox="0 0 24 24" className={`size-4 ${dictation.listening ? 'animate-pulse motion-reduce:animate-none' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
              </button>
            )}
          </Tooltip>
        )}
        <Tooltip text={sendLabel}>
          {(tip) => (
            <span {...tip} className="shrink-0">
              <button type="button" onClick={button === 'stop' ? onStop : send} disabled={button !== 'ready' && button !== 'stop'} aria-label={button === 'sending' ? 'Sending' : button === 'stop' ? 'Stop' : 'Send'} aria-busy={button === 'sending'} className={`grid size-8 shrink-0 place-items-center rounded-full transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none ${button === 'ready' || button === 'stop' ? 'bg-accent text-accent-ink hover:bg-accent/90' : button === 'sending' ? 'bg-white/[0.1] text-ink-200' : 'bg-white/[0.07] text-ink-500'}`}>
                {button === 'sending' ? <Spinner /> : button === 'stop' ? <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2.5" /></svg> : <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" /></svg>}
              </button>
            </span>
          )}
        </Tooltip>
      </div>
    </div>
  )
}
