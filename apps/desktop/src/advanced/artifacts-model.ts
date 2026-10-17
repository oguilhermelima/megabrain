import type { Artifact, ArtifactContent, ArtifactKind } from '@/api/schema'
import type { WidthStorage } from '@/lib/panel-width'
import { rememberedTabs } from '@/lib/remembered-tabs'
import { itemKey, parseItem } from '@/panes/pane-model'

// The Artifacts page: the diagrams, plans and docs agents filed, by project and kind, as `artifact list`
// returns them, one project at a time like the Knowledge page. An artifact reads in tabs: rendered
// (Preview), what it is and where it came from (Details), and its raw text (Source); each artifact
// remembers the tab last shown on it. The page is one item in the layout, keyed by the artifact it shows. An HTML artifact
// renders in a sandboxed frame (no scripts, no same-origin) whose document carries its own policy
// blocking every fetch, so a page an agent wrote can reach neither the app nor the network.

export type ArtifactKindGroup = { kind: ArtifactKind; artifacts: Artifact[] }
export type ArtifactProject = { project: string; name: string; kinds: ArtifactKindGroup[] }

/** The kinds in the order the navigation lists them, with their group titles and the name of one. */
export const artifactKinds: readonly { kind: ArtifactKind; title: string; label: string }[] = [
  { kind: 'diagram', title: 'Diagrams', label: 'Diagram' },
  { kind: 'plan', title: 'Plans', label: 'Plan' },
  { kind: 'doc', title: 'Docs', label: 'Doc' },
]

export const artifactKindLabel = (kind: ArtifactKind): string => artifactKinds.find((entry) => entry.kind === kind)?.label ?? kind

const newestFirst = (left: Artifact, right: Artifact) => right.updatedAt.localeCompare(left.updatedAt)

/** Artifacts by project, ordered by each project's latest change, then by kind in a fixed order, each kind newest first. */
export function groupArtifacts(artifacts: readonly Artifact[]): ArtifactProject[] {
  const projects = new Map<string, { name: string; artifacts: Artifact[] }>()
  for (const artifact of [...artifacts].sort(newestFirst)) {
    const project = projects.get(artifact.project) ?? { name: artifact.projectName, artifacts: [] }
    project.artifacts.push(artifact)
    projects.set(artifact.project, project)
  }
  return [...projects].map(([project, { name, artifacts: listed }]) => ({
    project,
    name,
    kinds: artifactKinds.map(({ kind }) => ({ kind, artifacts: listed.filter((artifact) => artifact.kind === kind) })).filter((group) => group.artifacts.length > 0),
  }))
}

/** The newest artifact of a grouped list: the first project's newest, whatever its kind. */
export const newestArtifact = (projects: readonly ArtifactProject[]): Artifact | null =>
  projects[0]?.kinds.flatMap((group) => group.artifacts).sort(newestFirst)[0] ?? null

/** The project the page shows: the picked artifact's, else the one with the newest change. */
export function shownArtifactProject(projects: readonly ArtifactProject[], picked: string | null): ArtifactProject | null {
  return projects.find((project) => project.kinds.some((group) => group.artifacts.some((artifact) => artifact.id === picked))) ?? projects[0] ?? null
}

/** The project's artifacts whose title contains the text, in any case; kinds left empty drop out. */
export function filterArtifactProject(project: ArtifactProject, text: string): ArtifactProject {
  const wanted = text.trim().toLowerCase()
  if (wanted === '') return project
  const kinds = project.kinds.map((group) => ({ ...group, artifacts: group.artifacts.filter((artifact) => artifact.title.toLowerCase().includes(wanted)) })).filter((group) => group.artifacts.length > 0)
  return { ...project, kinds }
}

export type ArtifactTab = 'preview' | 'details' | 'source'

const tabOrder: { tab: ArtifactTab; label: string }[] = [
  { tab: 'preview', label: 'Preview' },
  { tab: 'details', label: 'Details' },
  { tab: 'source', label: 'Source' },
]

/** An artifact's tabs in their fixed order; Details counts the versions once there is more than one. */
export function artifactTabs(artifact: Pick<ArtifactContent, 'revision'>): { tab: ArtifactTab; label: string; count: number | null }[] {
  return tabOrder.map(({ tab, label }) => ({ tab, label, count: tab === 'details' && artifact.revision > 1 ? artifact.revision : null }))
}

/** The tab chosen, when the artifact has it; else Preview. */
export function shownArtifactTab(tabs: readonly { tab: ArtifactTab }[], chosen: ArtifactTab | null): ArtifactTab {
  return chosen !== null && tabs.some((entry) => entry.tab === chosen) ? chosen : 'preview'
}

/** Where every artifact's last tab is kept. */
export const artifactTabsKey = 'megabrain.artifacts.tabs'

const remembered = rememberedTabs<ArtifactTab>(artifactTabsKey, tabOrder.map((entry) => entry.tab))

export const readArtifactTab: (storage: () => WidthStorage, artifact: string) => ArtifactTab | null = remembered.read

export const writeArtifactTab: (storage: () => WidthStorage, artifact: string, tab: ArtifactTab) => ArtifactTab = remembered.write

export type RevisionRow = { revision: number; title: string; at: string; replacedAt: string | null; current: boolean }

/** The artifact's versions newest first: the current one, then those its updates replaced, each written `at` and, but the current, replaced. */
export function revisionRows(artifact: Pick<ArtifactContent, 'revision' | 'title' | 'updatedAt' | 'revisions'>): RevisionRow[] {
  const earlier = [...(artifact.revisions ?? [])].reverse().map((entry): RevisionRow => ({ revision: entry.revision, title: entry.title, at: entry.updatedAt, replacedAt: entry.replacedAt, current: false }))
  return [{ revision: artifact.revision, title: artifact.title, at: artifact.updatedAt, replacedAt: null, current: true }, ...earlier]
}

/** The artifacts filed under a topic, newest first. */
export const artifactsForTopic = (artifacts: readonly Artifact[], topic: string): Artifact[] => artifacts.filter((artifact) => artifact.topics.includes(topic)).sort(newestFirst)

/** The Artifacts page's id while it shows no artifact the person picked: it opens on the newest one. */
const latest = 'latest'

/** The Artifacts page, one item in the layout, keyed by the artifact it shows so a restored layout reopens it there. */
export const artifactsItem = (id: string | null): string => itemKey('artifact', id ?? latest)

/** The artifact an Artifacts page item's id picks; null on the latest page. */
export const artifactOfItem = (id: string): string | null => (id === latest ? null : id)

/** The Artifacts page among a layout's items, if one shows it. */
export const artifactsItemIn = (items: readonly string[]): string | null => items.find((item) => parseItem(item)?.kind === 'artifact') ?? null

/** The frame document's own policy: inline styles and inline images only; no script, font, frame or fetch of any kind. */
export const artifactFrameCsp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"

const policy = `<meta http-equiv="Content-Security-Policy" content="${artifactFrameCsp}">`

/** The artifact's HTML with the policy as the first thing in its head, so it applies before anything loads. */
export function artifactFrameDocument(html: string): string {
  const head = /<head\b[^>]*>/i.exec(html)
  if (head !== null) return `${html.slice(0, head.index + head[0].length)}${policy}${html.slice(head.index + head[0].length)}`
  const root = /<html\b[^>]*>/i.exec(html)
  if (root !== null) return `${html.slice(0, root.index + root[0].length)}<head>${policy}</head>${html.slice(root.index + root[0].length)}`
  return `<!doctype html><html><head>${policy}</head><body>${html}</body></html>`
}
