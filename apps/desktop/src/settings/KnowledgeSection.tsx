import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { Project, Settings } from '@/api/schema'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { displayName as projectName } from '@/advanced/appearance-model'
import { displayName } from '@/chat/composer-status'
import { ErrorNote } from '@/components/ui'
import { field, quiet, SettingRow, SettingsGroup, Switch } from '@/settings/settings-ui'
import { effectiveToggles, inEffect, inherited, parseKnowledgeSettings, resetProjectToggle, serialiseKnowledgeSettings, toggleInfo, toggleKeys, withDefault, withProjectToggle, type KnowledgeSettings, type ToggleKey } from '@/settings/knowledge-model'
import { effortLevels, parseChatSummaries, serialiseChatSummaries, summaryAgents, summaryModels, withAgent, withModel, type ChatSummaries, type SummaryAgent } from '@/settings/summaries-model'

const agentNames: Record<SummaryAgent, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', agy: 'agy' }

/** The project table's column heads, short enough for one line each. */
const columnLabels: Record<ToggleKey, string> = { summaries: 'Summaries', retitle: 'Retitle', topics: 'Topics', sessions: 'Outside', context: 'Context' }

/** A toggle's column on a project row: its switch, and whether it is the default's or the project's own, which resets. */
function ToggleCell({ settings, repo, toggle, onChange }: { settings: KnowledgeSettings; repo: string; toggle: ToggleKey; onChange: (next: KnowledgeSettings) => void }) {
  const toggles = effectiveToggles(settings, repo)
  const own = !inherited(settings, repo, toggle)
  const label = `${toggleInfo[toggle].label} for ${repo}`
  return (
    <div className="flex w-[62px] shrink-0 flex-col items-center gap-1">
      <Switch label={label} checked={toggles[toggle]} disabled={toggle !== 'summaries' && !toggles.summaries} onChange={(value) => onChange(withProjectToggle(settings, repo, toggle, value))} />
      {own ? (
        <button type="button" onClick={() => onChange(resetProjectToggle(settings, repo, toggle))} title={`Use the default (${settings.defaults[toggle] ? 'on' : 'off'})`} className="text-[10.5px] font-medium text-accent hover:underline">
          Reset
        </button>
      ) : (
        <span className="text-[10.5px] text-ink-500">Default</span>
      )}
    </div>
  )
}

/**
 * Knowledge: what each project keeps (summaries, retitles, topics, outside sessions, agent context),
 * as defaults and per project, then the agent, model and effort that write summaries and topics, and
 * how often. Every change saves at once. `chat` is the native chat focused when Settings opened, which
 * Summarize now runs on; `focusProject` is the project row to bring into view.
 */
export function KnowledgeSection({ models, chat, projects, focusProject }: { models: Settings['models']; chat: { id: string; title: string } | null; projects: Project[]; focusProject: string | null }) {
  const [saved, setSaved] = useState<ChatSummaries | null>(null)
  const [knowledge, setKnowledge] = useState<KnowledgeSettings | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [summarizing, setSummarizing] = useState<'idle' | 'running' | 'done'>('idle')
  const focused = useRef<HTMLDivElement>(null)

  useEffect(() => {
    Promise.all([api.chatSummaries(), api.knowledgeSettings()]).then(
      ([raw, rawKnowledge]) => {
        setSaved(parseChatSummaries(raw))
        setKnowledge(parseKnowledgeSettings(rawKnowledge, raw))
      },
      (caught: unknown) => setError(caught),
    )
  }, [])
  const ready = knowledge !== null
  useEffect(() => {
    if (ready) focused.current?.scrollIntoView({ block: 'center' })
  }, [ready])

  if (saved === null || knowledge === null) return error === null ? null : <ErrorNote error={error} />

  const saveKnowledge = (next: KnowledgeSettings) => {
    setKnowledge(next)
    api.setKnowledgeSettings(serialiseKnowledgeSettings(next)).then(
      () => setError(null),
      (caught: unknown) => setError(caught),
    )
  }

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
  const number = `${field} w-20 text-right tabular-nums`
  const every = (key: 'everyMessages' | 'everyMinutes') => (value: string) => {
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed > 0) save({ ...saved, [key]: parsed })
  }

  return (
    <>
      <p className="px-1 text-[13px] text-ink-400">An agent reads each project’s chats now and then, writes up where each stands, and files what they build and decide under topics on the Knowledge page. A project with summaries off sends nothing to any model.</p>
      <SettingsGroup title="Model">
        <SettingRow label="Agent" htmlFor="summaries-agent" description="The agent whose model writes the summaries.">
          <select id="summaries-agent" className={field} value={saved.agent} onChange={(event) => save(withAgent(saved, event.target.value as SummaryAgent, models))}>
            {summaryAgents.map((agent) => (
              <option key={agent} value={agent}>
                {agentNames[agent]}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="Model" htmlFor="summaries-model" description="A small, fast model is enough.">
          <select id="summaries-model" className={`${field} max-w-56`} value={saved.model} onChange={(event) => save(withModel(saved, event.target.value, models))}>
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
          <select id="summaries-effort" className={field} disabled={levels.length === 0} value={saved.effort ?? ''} onChange={(event) => save({ ...saved, effort: event.target.value === '' ? null : event.target.value })}>
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
          <input id="summaries-messages" type="number" min={1} step={1} className={number} defaultValue={saved.everyMessages} key={`m${saved.everyMessages}`} onBlur={(event) => every('everyMessages')(event.target.value)} />
        </SettingRow>
        <SettingRow label="Every M minutes" htmlFor="summaries-minutes" description="Or after this long, if the chat moved at all.">
          <input id="summaries-minutes" type="number" min={1} step={1} className={number} defaultValue={saved.everyMinutes} key={`n${saved.everyMinutes}`} onBlur={(event) => every('everyMinutes')(event.target.value)} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Defaults">
        {toggleKeys.map((toggle) => (
          <SettingRow key={toggle} label={toggleInfo[toggle].label} description={toggleInfo[toggle].description}>
            <Switch label={`${toggleInfo[toggle].label} by default`} checked={knowledge.defaults[toggle]} disabled={toggle !== 'summaries' && !knowledge.defaults.summaries} onChange={(value) => saveKnowledge(withDefault(knowledge, toggle, value))} />
          </SettingRow>
        ))}
      </SettingsGroup>
      {projects.length > 0 && (
        <SettingsGroup
          title="Projects"
          aside={
            <div className="flex gap-1.5 pr-4" aria-hidden="true">
              {toggleKeys.map((toggle) => (
                <span key={toggle} className="w-[62px] text-center text-[10.5px] font-semibold tracking-[0.04em] whitespace-nowrap text-ink-400 uppercase">
                  {columnLabels[toggle]}
                </span>
              ))}
            </div>
          }
        >
          {[...projects]
            .sort((left, right) => projectName(left).localeCompare(projectName(right)))
            .map((project) => {
              const on = inEffect(effectiveToggles(knowledge, project.path), 'summaries')
              return (
                <div key={project.path} ref={project.path === focusProject ? focused : undefined} className={`flex min-h-16 items-center gap-1.5 px-4 py-2.5 ${project.path === focusProject ? 'bg-accent/[0.06]' : ''}`}>
                  <ProjectPicture project={project} />
                  <div className="min-w-0 flex-1 pl-1.5">
                    <p className="truncate text-[13.5px] font-medium text-ink-100">{projectName(project)}</p>
                    <p className="truncate text-[12px] text-ink-400" title={project.path}>
                      {on ? project.path : 'Off: nothing is sent to a model'}
                    </p>
                  </div>
                  {toggleKeys.map((toggle) => (
                    <ToggleCell key={toggle} settings={knowledge} repo={project.path} toggle={toggle} onChange={saveKnowledge} />
                  ))}
                </div>
              )
            })}
        </SettingsGroup>
      )}
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
