// The Settings window's navigation: the fixed sections in their groups, then every project under a
// last Projects group, alphabetical by display name, and how the keyboard walks them all.

import { compareByDisplayName, displayName } from '@/advanced/appearance-model'
import type { ProjectAppearance } from '@/api/schema'

export type Section = 'usage' | 'agents' | 'shortcuts' | 'models' | 'chains' | 'summaries' | 'supervisor' | 'limits' | 'terminal' | 'worktrees'

/** A section, or one project's page by its repository path. */
export type NavKey = Section | `project:${string}`

export type SectionIcon = 'gauge' | 'agents' | 'keyboard' | 'cpu' | 'link' | 'note' | 'eye' | 'sliders' | 'terminal' | 'folder'

export interface SectionInfo {
  key: Section
  label: string
  /** One line under the section's title. */
  description: string
  icon: SectionIcon
  group: 'General' | 'Agents' | 'System'
}

/** In navigation order; groups follow the order their first section appears in. */
export const settingsSections: SectionInfo[] = [
  { key: 'usage', label: 'Usage', description: 'Tokens, estimated cost and limits across your agents, from their own logs.', icon: 'gauge', group: 'General' },
  { key: 'shortcuts', label: 'Shortcuts', description: 'The keys for the window’s actions, Orca’s where Orca has the same action.', icon: 'keyboard', group: 'General' },
  { key: 'agents', label: 'Agents', description: 'The agents installed here, the command each starts with, and the one New chat uses.', icon: 'agents', group: 'Agents' },
  { key: 'models', label: 'Models', description: 'The models each agent can run, and their reasoning levels.', icon: 'cpu', group: 'Agents' },
  { key: 'chains', label: 'Chains', description: 'Which agent and model a dispatch tries first, and what it falls back to.', icon: 'link', group: 'Agents' },
  { key: 'summaries', label: 'Summaries', description: 'A short summary of each chat as it goes, and the model that writes it.', icon: 'note', group: 'Agents' },
  { key: 'supervisor', label: 'Supervisor', description: 'The watcher that reports stuck, finished or dead children, and setup.', icon: 'eye', group: 'Agents' },
  { key: 'limits', label: 'Limits', description: 'When a new agent may start, by machine load, and resource history.', icon: 'sliders', group: 'System' },
  { key: 'terminal', label: 'Terminal', description: 'The terminal engine inside the app and the one opened outside it.', icon: 'terminal', group: 'System' },
  { key: 'worktrees', label: 'Worktrees', description: 'Where new worktrees are created, for every project or one at a time.', icon: 'folder', group: 'System' },
]

/** What the navigation needs of a project. */
export interface NavProject {
  name: string
  path: string
  appearance?: ProjectAppearance
  worktrees: { path: string }[]
}

export interface NavItem<P extends NavProject = NavProject> {
  key: NavKey
  label: string
  /** The project a project item opens; null for a section. */
  project: P | null
}

export type NavGroupLabel = SectionInfo['group'] | 'Projects'

export function projectKey(path: string): NavKey {
  return `project:${path}`
}

/** The repository path a key names; null for a section. */
export function projectPathOf(key: NavKey): string | null {
  return key.startsWith('project:') ? key.slice('project:'.length) : null
}

export function navGroups<P extends NavProject>(projects: P[]): { label: NavGroupLabel; items: NavItem<P>[] }[] {
  const groups: { label: NavGroupLabel; items: NavItem<P>[] }[] = []
  for (const section of settingsSections) {
    const item: NavItem<P> = { key: section.key, label: section.label, project: null }
    const group = groups.find((entry) => entry.label === section.group)
    if (group === undefined) groups.push({ label: section.group, items: [item] })
    else group.items.push(item)
  }
  if (projects.length > 0) {
    groups.push({ label: 'Projects', items: [...projects].sort(compareByDisplayName).map((project) => ({ key: projectKey(project.path), label: displayName(project), project })) })
  }
  return groups
}

/** Every key in the order shown, for the arrow keys. */
export function navKeys(projects: NavProject[]): NavKey[] {
  return navGroups(projects).flatMap((group) => group.items.map((item) => item.key))
}

/** A section's title, line and icon; a project key gets the first section's, which its page does not show. */
export function sectionInfo(key: NavKey): SectionInfo {
  return settingsSections.find((section) => section.key === key) ?? (settingsSections[0] as SectionInfo)
}

/**
 * Usage, unless Settings opens on a project (Edit commands in a chat's run menu). A worktree path
 * opens its repository's page; a path the list does not know yet keeps its own key.
 */
export function initialKey(focus: string | null, projects: NavProject[]): NavKey {
  if (focus === null) return 'usage'
  const owner = projects.find((project) => project.path === focus || project.worktrees.some((worktree) => worktree.path === focus))
  return projectKey(owner?.path ?? focus)
}

/** The key an arrow key moves to, wrapping at both ends; an unknown current starts at the first. */
export function adjacentKey(keys: NavKey[], current: NavKey, offset: 1 | -1): NavKey {
  const index = keys.indexOf(current)
  if (index === -1) return keys[0] ?? current
  return keys[(index + offset + keys.length) % keys.length] ?? current
}
