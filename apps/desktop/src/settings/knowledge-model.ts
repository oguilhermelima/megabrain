// What the knowledge base keeps, per project: settings key knowledge holds a default for each toggle
// and each project's own values; a project inherits every toggle it has not set. Summaries is the
// root: retitle, topics, sessions and context do nothing without it, and a project with summaries off
// sends nothing to any model. Saved as JSON through `megabrain settings set knowledge`.

export const toggleKeys = ['summaries', 'retitle', 'topics', 'sessions', 'context'] as const
export type ToggleKey = (typeof toggleKeys)[number]
export type Toggles = Record<ToggleKey, boolean>

export interface KnowledgeSettings {
  defaults: Toggles
  /** By repository path; a key left out is inherited from the defaults. */
  projects: Record<string, Partial<Toggles>>
}

export const allOn: Toggles = { summaries: true, retitle: true, topics: true, sessions: true, context: true }

export const toggleInfo: Record<ToggleKey, { label: string; description: string }> = {
  summaries: { label: 'Summaries', description: 'Summarize this project’s chats and sessions.' },
  retitle: { label: 'Retitle', description: 'Rename chats from their summaries. A title you set is kept.' },
  topics: { label: 'Topics', description: 'File summaries into knowledge topics.' },
  sessions: { label: 'Outside sessions', description: 'Also read sessions opened outside the app: Orca, Superset, terminals and dispatch workers.' },
  context: { label: 'Agent context', description: 'Give agents the topics for their branch.' },
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The toggles a record sets, each a boolean; anything else is left out. */
function readToggles(value: unknown): Partial<Toggles> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(toggleKeys.flatMap((key) => (typeof value[key] === 'boolean' ? [[key, value[key]]] : []))) as Partial<Toggles>
}

/**
 * What `settings get knowledge` printed. Until defaults are saved, they come once from what chat
 * summaries held: its enabled becomes summaries and its retitle becomes retitle.
 */
export function parseKnowledgeSettings(raw: unknown, chatSummaries: unknown): KnowledgeSettings {
  const saved = isRecord(raw) ? raw : {}
  const old = isRecord(chatSummaries) ? chatSummaries : {}
  const migrated: Partial<Toggles> = isRecord(saved.defaults) ? {} : readToggles({ summaries: old.enabled, retitle: old.retitle })
  const projects = isRecord(saved.projects) ? Object.fromEntries(Object.entries(saved.projects).flatMap(([repo, value]) => (isRecord(value) ? [[repo, readToggles(value)]] : []))) : {}
  return { defaults: { ...allOn, ...migrated, ...readToggles(saved.defaults) }, projects }
}

export const serialiseKnowledgeSettings = (settings: KnowledgeSettings): string => JSON.stringify({ defaults: settings.defaults, projects: settings.projects })

/** A project's toggles: its own values, else the defaults. */
export const effectiveToggles = (settings: KnowledgeSettings, repo: string): Toggles => ({ ...settings.defaults, ...settings.projects[repo] })

/** Whether a toggle does anything: every one but summaries needs summaries on. */
export const inEffect = (toggles: Toggles, key: ToggleKey): boolean => toggles[key] && toggles.summaries

/** Whether the project takes this toggle from the defaults. */
export const inherited = (settings: KnowledgeSettings, repo: string, key: ToggleKey): boolean => settings.projects[repo]?.[key] === undefined

export const withDefault = (settings: KnowledgeSettings, key: ToggleKey, value: boolean): KnowledgeSettings => ({ ...settings, defaults: { ...settings.defaults, [key]: value } })

export const withProjectToggle = (settings: KnowledgeSettings, repo: string, key: ToggleKey, value: boolean): KnowledgeSettings => ({
  ...settings,
  projects: { ...settings.projects, [repo]: { ...settings.projects[repo], [key]: value } },
})

/** The project inherits this toggle again; a project with nothing of its own is dropped. */
export function resetProjectToggle(settings: KnowledgeSettings, repo: string, key: ToggleKey): KnowledgeSettings {
  const { [key]: _reset, ...rest } = settings.projects[repo] ?? {}
  const { [repo]: _project, ...others } = settings.projects
  return { ...settings, projects: Object.keys(rest).length === 0 ? others : { ...others, [repo]: rest } }
}
