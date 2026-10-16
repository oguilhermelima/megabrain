import { useState } from 'react'
import type { SlashCommand } from '@/api/schema'
import type { AnchorRect } from '@/advanced/menu-placement'
import { commandSections } from '@/chat/command-menu'
import { CommandMenu, handleMenuKey } from '@/chat/CommandMenu'

const skillSources: SlashCommand['source'][] = ['skill', 'plugin']

/** The agent's skills and plugin skills in the shared command menu, anchored to the composer's skills button, with a search of its own. */
export function SkillMenu({ anchor, commands, recent, leaving, onPick, onClose }: { anchor: AnchorRect; commands: SlashCommand[]; recent: string[]; leaving: boolean; onPick: (command: SlashCommand) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const sections = commandSections(commands, query, recent, { sources: skillSources })
  const items = sections.flatMap((section) => section.items)
  const current = Math.min(active, Math.max(0, items.length - 1))
  return (
    <CommandMenu
      anchor={anchor}
      label="Skills"
      sections={sections}
      active={current}
      query={query}
      width={560}
      leaving={leaving}
      search={{
        value: query,
        placeholder: 'Search skills',
        onChange: (value) => {
          setQuery(value)
          setActive(0)
        },
        onKeyDown: (event) => {
          handleMenuKey(event, items.length, current, {
            move: setActive,
            pick: () => {
              const item = items[current]
              if (item !== undefined) onPick(item.command)
            },
            close: onClose,
          })
        },
      }}
      onActive={setActive}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
