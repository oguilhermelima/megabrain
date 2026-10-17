import type { Artifact, ArtifactKind } from '@/api/schema'
import { itemKey, parseItem } from '@/panes/pane-model'

// The Artifacts page: the diagrams, plans and docs agents filed, by project and kind, as `artifact list`
// returns them. The page is one item in the layout, keyed by the artifact it shows. An HTML artifact
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
