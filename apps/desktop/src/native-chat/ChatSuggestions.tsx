import { useEffect, useState } from 'react'
import { api } from '@/api'
import { LivingOrb } from '@/components/LivingOrb'
import { chatSuggestions, emptyChatText, type SuggestionIcon } from '@/native-chat/empty-chat'

// A new chat with nothing said yet: the orb thinking, a question about the worktree and a few things
// to ask instead of a spinner. The agent waits for the first message anyway, so there is nothing to
// load before it.

// The 16-unit grid and 1.5 stroke of the app's other glyphs (components/menu-icons.tsx).
const icons: Record<SuggestionIcon, string> = {
  explain: 'M8 4.2C6.8 3.2 5 2.8 2.5 3v9c2.5-.2 4.3.2 5.5 1.2 1.2-1 3-1.4 5.5-1.2V3c-2.5-.2-4.3.2-5.5 1.2ZM8 4.2v9',
  bugs: 'M5.5 6.5a2.5 2.5 0 0 1 5 0V10a2.5 2.5 0 0 1-5 0ZM6 4.5 4.8 3M10 4.5 11.2 3M5.5 8H2.5M13.5 8h-3M5.5 11 3 12.5M10.5 11 13 12.5M8 8.5v4',
  tests: 'M6 2.5h4M6.75 2.5v4L3.2 12.2a.9.9 0 0 0 .8 1.3h8a.9.9 0 0 0 .8-1.3L9.25 6.5v-4M4.6 10h6.8',
  pulls: 'M4 1.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2M4 10.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2M12 10.9a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 1 0 0-3.2M4 5.1v5.8M12 10.9V6.5a2 2 0 0 0-2-2H7.5',
}

/** The empty chat: the orb, what to do and the suggestions; picking one fills the composer. */
export function ChatSuggestions({ cwd, agent, onPick }: { cwd: string; agent: string; onPick: (text: string) => void }) {
  const [changed, setChanged] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    api.codeChanges(cwd).then(
      (changes) => {
        const file = changes.find((change) => change.status !== 'deleted')
        if (current && file !== undefined) setChanged(file.path)
      },
      () => {},
    )
    return () => {
      current = false
    }
  }, [cwd])
  const { headline, detail } = emptyChatText(agent, cwd)
  return (
    // Sized by the pane, not the window, so each pane of a split fits its own width.
    <div className="@container/empty flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="motion-fade mx-auto my-auto flex w-full max-w-[700px] flex-col items-center px-8 py-12 text-center [--orb:112px] @max-[640px]/empty:px-5 @max-[640px]/empty:py-8 @max-[640px]/empty:[--orb:72px]">
        <LivingOrb size="var(--orb)" />
        <h2 className="mt-9 text-[22px] font-semibold tracking-[-0.01em] text-ink-100 [overflow-wrap:anywhere] @max-[640px]/empty:mt-6 @max-[640px]/empty:text-[18px]">{headline}</h2>
        <p className="mt-2 max-w-[440px] text-[14px] leading-relaxed text-ink-400 @max-[640px]/empty:text-[13px]">{detail}</p>
        <div className="mt-8 grid w-full grid-cols-1 gap-2.5 @min-[640px]/empty:grid-cols-2 @max-[640px]/empty:mt-6">
          {chatSuggestions(changed).map((item) => (
            <button
              key={item.icon}
              type="button"
              onClick={() => onPick(item.title)}
              className="group flex items-start gap-3 rounded-[18px] border border-white/[0.08] bg-white/[0.03] px-4 py-3.5 text-left transition-[translate,background-color,border-color] duration-[var(--motion-enter)] ease-[var(--motion-ease-out)] hover:-translate-y-0.5 hover:border-white/[0.14] hover:bg-white/[0.06] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:hover:translate-y-0"
            >
              <span className="mt-px flex size-8 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-ink-300 transition-colors group-hover:text-accent">
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={icons[item.icon]} />
                </svg>
              </span>
              <span className="min-w-0">
                <span className="line-clamp-2 block text-[13.5px] font-medium text-ink-100 [overflow-wrap:anywhere]">{item.title}</span>
                <span className="mt-0.5 block truncate text-[12.5px] text-ink-400" title={item.hint}>
                  {item.hint}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
