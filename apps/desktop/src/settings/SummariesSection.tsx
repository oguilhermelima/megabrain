import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { Settings } from '@/api/schema'
import { displayName } from '@/chat/composer-status'
import { ErrorNote } from '@/components/ui'
import { field, quiet, SettingRow, SettingsGroup, Switch } from '@/settings/settings-ui'
import { effortLevels, parseChatSummaries, serialiseChatSummaries, summaryAgents, summaryModels, withAgent, withModel, type ChatSummaries, type SummaryAgent } from '@/settings/summaries-model'

const agentNames: Record<SummaryAgent, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', agy: 'agy' }

/**
 * Chat summaries: the switch, the agent, model and effort that write them, how often, and whether
 * they may retitle a chat. Every change saves at once. `chat` is the native chat focused when
 * Settings opened, which Summarize now runs on.
 */
export function SummariesSection({ models, chat }: { models: Settings['models']; chat: { id: string; title: string } | null }) {
  const [saved, setSaved] = useState<ChatSummaries | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [summarizing, setSummarizing] = useState<'idle' | 'running' | 'done'>('idle')

  useEffect(() => {
    api.chatSummaries().then(
      (raw) => setSaved(parseChatSummaries(raw)),
      (caught: unknown) => setError(caught),
    )
  }, [])

  if (saved === null) return error === null ? null : <ErrorNote error={error} />

  const save = (next: ChatSummaries) => {
    setSaved(next)
    api.setChatSummaries(serialiseChatSummaries(next)).then(
      () => setError(null),
      (caught: unknown) => setError(caught),
    )
  }
  const summarize = (id: string) => {
    setSummarizing('running')
    api.summarizeChat(id).then(
      () => setSummarizing('done'),
      (caught: unknown) => {
        setSummarizing('idle')
        setError(caught)
      },
    )
  }

  const groups = summaryModels(models, saved.agent)
  const levels = effortLevels(models, saved.agent, saved.model)
  const listed = [...groups.current, ...groups.older].some((entry) => entry.model === saved.model)
  const off = !saved.enabled
  const number = `${field} w-20 text-right tabular-nums`
  const every = (key: 'everyMessages' | 'everyMinutes') => (value: string) => {
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed > 0) save({ ...saved, [key]: parsed })
  }

  return (
    <>
      <p className="px-1 text-[13px] text-ink-400">An agent reads each chat now and then and writes a few lines on where it stands, shown with the chat; it can also give an untitled chat a better name.</p>
      <SettingsGroup>
        <SettingRow label="Summarize chats" description="Off by default. Each summary is one short call to the model below.">
          <Switch label="Summarize chats" checked={saved.enabled} onChange={(enabled) => save({ ...saved, enabled })} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Model">
        <SettingRow label="Agent" htmlFor="summaries-agent" description="The agent whose model writes the summaries.">
          <select id="summaries-agent" className={field} disabled={off} value={saved.agent} onChange={(event) => save(withAgent(saved, event.target.value as SummaryAgent, models))}>
            {summaryAgents.map((agent) => (
              <option key={agent} value={agent}>
                {agentNames[agent]}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="Model" htmlFor="summaries-model" description="A small, fast model is enough.">
          <select id="summaries-model" className={`${field} max-w-56`} disabled={off} value={saved.model} onChange={(event) => save(withModel(saved, event.target.value, models))}>
            <option value="">Agent default</option>
            {!listed && saved.model !== '' && <option value={saved.model}>{saved.model}</option>}
            {groups.current.length > 0 && (
              <optgroup label="Current">
                {groups.current.map((entry) => (
                  <option key={entry.model} value={entry.model}>
                    {displayName(entry.model, models)}
                  </option>
                ))}
              </optgroup>
            )}
            {groups.older.length > 0 && (
              <optgroup label="Older">
                {groups.older.map((entry) => (
                  <option key={entry.model} value={entry.model}>
                    {displayName(entry.model, models)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </SettingRow>
        <SettingRow label="Reasoning" htmlFor="summaries-effort" description="Low keeps summaries quick and cheap.">
          <select id="summaries-effort" className={field} disabled={off || levels.length === 0} value={saved.effort ?? ''} onChange={(event) => save({ ...saved, effort: event.target.value === '' ? null : event.target.value })}>
            <option value="">Default</option>
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="When">
        <SettingRow label="Every N messages" htmlFor="summaries-messages" description="After this many new messages in a chat.">
          <input id="summaries-messages" type="number" min={1} step={1} className={number} disabled={off} defaultValue={saved.everyMessages} key={`m${saved.everyMessages}`} onBlur={(event) => every('everyMessages')(event.target.value)} />
        </SettingRow>
        <SettingRow label="Every M minutes" htmlFor="summaries-minutes" description="Or after this long, if the chat moved at all.">
          <input id="summaries-minutes" type="number" min={1} step={1} className={number} disabled={off} defaultValue={saved.everyMinutes} key={`n${saved.everyMinutes}`} onBlur={(event) => every('everyMinutes')(event.target.value)} />
        </SettingRow>
        <SettingRow label="Retitle chats" description="A summary may rename a chat. A title you set yourself is kept.">
          <Switch label="Retitle chats" disabled={off} checked={saved.retitle} onChange={(retitle) => save({ ...saved, retitle })} />
        </SettingRow>
      </SettingsGroup>
      {chat !== null && (
        <SettingsGroup>
          <SettingRow label="Summarize now" description={summarizing === 'done' ? `Asked for a summary of ${chat.title}.` : `Summarize ${chat.title} now, whatever the schedule.`}>
            <button type="button" disabled={summarizing === 'running'} onClick={() => summarize(chat.id)} className={`${quiet} border border-white/[0.1] bg-white/[0.04]`}>
              {summarizing === 'running' ? 'Summarizing…' : 'Summarize now'}
            </button>
          </SettingRow>
        </SettingsGroup>
      )}
      {error !== null && <ErrorNote error={error} />}
    </>
  )
}
