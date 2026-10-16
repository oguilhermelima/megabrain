// The Settings window's navigation: which sections exist, how they group and how the keyboard walks them.

export type Section = 'usage' | 'projects' | 'models' | 'chains' | 'supervisor' | 'limits' | 'terminal'

export type SectionIcon = 'gauge' | 'folder' | 'cpu' | 'link' | 'eye' | 'sliders' | 'terminal'

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
  { key: 'usage', label: 'Usage', description: 'How much of each provider’s limits your agents have used.', icon: 'gauge', group: 'General' },
  { key: 'projects', label: 'Projects', description: 'The Run, Build and Install commands each project offers in a chat.', icon: 'folder', group: 'General' },
  { key: 'models', label: 'Models', description: 'The models each agent can run, and their reasoning levels.', icon: 'cpu', group: 'Agents' },
  { key: 'chains', label: 'Chains', description: 'Which agent and model a dispatch tries first, and what it falls back to.', icon: 'link', group: 'Agents' },
  { key: 'supervisor', label: 'Supervisor', description: 'The watcher that reports stuck, finished or dead children, and setup.', icon: 'eye', group: 'Agents' },
  { key: 'limits', label: 'Limits', description: 'When a new agent may start, by machine load, and resource history.', icon: 'sliders', group: 'System' },
  { key: 'terminal', label: 'Terminal', description: 'The terminal engine inside the app and the one opened outside it.', icon: 'terminal', group: 'System' },
]

export function navGroups(): { label: SectionInfo['group']; sections: SectionInfo[] }[] {
  const groups: { label: SectionInfo['group']; sections: SectionInfo[] }[] = []
  for (const section of settingsSections) {
    const group = groups.find((item) => item.label === section.group)
    if (group === undefined) groups.push({ label: section.group, sections: [section] })
    else group.sections.push(section)
  }
  return groups
}

export function sectionInfo(key: Section): SectionInfo {
  return settingsSections.find((section) => section.key === key) ?? (settingsSections[0] as SectionInfo)
}

/** Usage, unless Settings opens on a project's commands. */
export function initialSection(focusProject: string | null): Section {
  return focusProject === null ? 'usage' : 'projects'
}

/** The section an arrow key moves to, wrapping at both ends. */
export function adjacentSection(current: Section, offset: 1 | -1): Section {
  const index = settingsSections.findIndex((section) => section.key === current)
  const next = (index + offset + settingsSections.length) % settingsSections.length
  return (settingsSections[next] as SectionInfo).key
}
