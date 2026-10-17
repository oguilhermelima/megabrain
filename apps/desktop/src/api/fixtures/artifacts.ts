import type { Artifact, ArtifactContent, ArtifactList } from '@/api/schema'

// Artifacts for the mock, shaped like `artifact list|show --json`: two projects, a diagram (HTML with
// inline SVG, fonts already stripped as the store saves them), plans and a doc in Markdown, and one
// artifact filed under a topic so the topic strip has something to show.

const root = '/Users/operator/Workspaces'
const state = '/Users/operator/.megabrain/knowledge'
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const canto = { project: `${root}/canto`, projectName: 'canto', projectId: 'canto-3f9a1c0b7d2e' }
const megabrain = { project: `${root}/megabrain`, projectName: 'megabrain', projectId: 'megabrain-8be41d07a5c6' }

const pipeline = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Knowledge pipeline</title>
<style>
  :root { --paper: #f6f5f1; --ink: #23262f; --muted: #6b6f7b; --rule: #d9d6cc; --accent: #bf4520; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 48px 40px; }
  .eyebrow { font: 600 11px/1 ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); }
  h1 { font-family: 'Instrument Serif', Georgia, serif; font-weight: 400; font-size: 40px; margin: 12px 0 8px; letter-spacing: -.01em; }
  p.lede { color: var(--muted); font-size: 15px; margin: 0 0 32px; max-width: 560px; line-height: 1.5; }
  svg { width: 100%; height: auto; display: block; }
  .box { fill: #fff; stroke: var(--ink); stroke-width: 1.25; }
  .box.focus { stroke: var(--accent); stroke-width: 1.75; }
  .label { font: 600 14px -apple-system, BlinkMacSystemFont, sans-serif; fill: var(--ink); }
  .note { font: 12px ui-monospace, 'SF Mono', Menlo, monospace; fill: var(--muted); }
  .edge { stroke: var(--ink); stroke-width: 1.25; fill: none; marker-end: url(#arrow); }
  .edge.dashed { stroke-dasharray: 4 4; stroke: var(--muted); }
  footer { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--rule); color: var(--muted); font: 12px ui-monospace, Menlo, monospace; }
</style>
</head>
<body>
<main>
  <div class="eyebrow">Architecture · Knowledge base</div>
  <h1>From session logs to topics</h1>
  <p class="lede">Every agent session in an enabled project is read once, summarised, then curated into the topic it belongs to.</p>
  <svg viewBox="0 0 880 300" role="img" aria-label="Session logs flow through the summarizer and curator into topics">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#23262f"/></marker></defs>
    <rect class="box" x="10" y="40" width="170" height="76" rx="6"/>
    <text class="label" x="28" y="72">Session logs</text>
    <text class="note" x="28" y="94">four agents</text>
    <rect class="box" x="250" y="40" width="170" height="76" rx="6"/>
    <text class="label" x="268" y="72">Scanner</text>
    <text class="note" x="268" y="94">inside chatd</text>
    <rect class="box focus" x="490" y="40" width="170" height="76" rx="6"/>
    <text class="label" x="508" y="72">Summarizer</text>
    <text class="note" x="508" y="94">REFS + KEY</text>
    <rect class="box focus" x="490" y="190" width="170" height="76" rx="6"/>
    <text class="label" x="508" y="222">Curator</text>
    <text class="note" x="508" y="244">ASSIGN or NEW</text>
    <rect class="box" x="720" y="190" width="150" height="76" rx="6"/>
    <text class="label" x="738" y="222">Topics</text>
    <text class="note" x="738" y="244">topic.json</text>
    <rect class="box" x="250" y="190" width="170" height="76" rx="6"/>
    <text class="label" x="268" y="222">Artifacts</text>
    <text class="note" x="268" y="244">megabrain artifact</text>
    <path class="edge" d="M180 78H246"/>
    <path class="edge" d="M420 78H486"/>
    <path class="edge" d="M575 116V186"/>
    <path class="edge" d="M660 228H716"/>
    <path class="edge dashed" d="M420 228H486"/>
  </svg>
  <footer>diagram-design · rendered offline with system fonts</footer>
</main>
</body>
</html>
`

const lanePlan = `# Artifacts lane

Agents file what they make for the person — diagrams, plans and docs — so it outlives the chat that made it.

## Steps

1. **Store and verbs.** \`megabrain artifact create|update|list|show|remove\`, one folder per artifact under the project's knowledge folder.
2. **Diagram skill.** The \`artifacts-diagram\` module installs diagram-design for every agent, pinned to a tested commit.
3. **Page.** An Artifacts entry in the sidebar opens a wiki page: the list by project and kind beside the artifact.

## Decisions

| Decision | Why |
| --- | --- |
| HTML renders in a sandboxed frame | An artifact is written by an agent; it must not reach the app or the network. |
| Google Fonts are stripped on save | The frame fetches nothing, so the page falls back to system fonts. |
| Content capped at 1 MiB | A diagram is tens of kilobytes; the cap keeps a stray log out. |

## Open

- [ ] Place the artifact strip on the topic page (knowledge lane).
- [x] Pane key round trip.
`

const searchPlan = `# Search rollout plan

The search field fired a request per key. The fix ships behind a flag first.

## Phases

1. Debounce at 250 ms, flag off by default.
2. Turn it on for the team, watch the request rate for a day.
3. Remove the flag.

> Rollback is flipping the flag; no migration is involved.
`

const offlineDoc = `# Offline playback notes

- Downloads land in the app's cache folder, keyed by title id.
- A download older than 30 days is refreshed on the next launch.
- \`pnpm test downloads\` covers expiry and refresh.
`

const entries: ArtifactContent[] = [
  { id: 'art-20261017-a1b2c3d4', title: 'Knowledge pipeline', kind: 'diagram', format: 'html', ...megabrain, topics: ['topic-knowledge'], chatId: 'chat-0001', createdAt: ago(240), updatedAt: ago(6), revision: 3, path: `${state}/${megabrain.projectId}/artifacts/art-20261017-a1b2c3d4/index.html`, content: pipeline },
  { id: 'art-20261017-0f1e2d3c', title: 'Artifacts lane', kind: 'plan', format: 'markdown', ...megabrain, topics: ['topic-knowledge'], chatId: null, createdAt: ago(300), updatedAt: ago(45), revision: 1, path: `${state}/${megabrain.projectId}/artifacts/art-20261017-0f1e2d3c/doc.md`, content: lanePlan },
  { id: 'art-20261016-9a8b7c6d', title: 'Search rollout plan', kind: 'plan', format: 'markdown', ...canto, topics: [], chatId: null, createdAt: ago(1500), updatedAt: ago(1500), revision: 1, path: `${state}/${canto.projectId}/artifacts/art-20261016-9a8b7c6d/doc.md`, content: searchPlan },
  { id: 'art-20261015-5e4d3c2b', title: 'Offline playback notes', kind: 'doc', format: 'markdown', ...canto, topics: [], chatId: null, createdAt: ago(2900), updatedAt: ago(2900), revision: 2, path: `${state}/${canto.projectId}/artifacts/art-20261015-5e4d3c2b/doc.md`, content: offlineDoc },
]

export function mockArtifactList(options: { project?: string; topic?: string } = {}): ArtifactList {
  const artifacts: Artifact[] = entries
    .filter((entry) => (options.project === undefined || entry.project === options.project) && (options.topic === undefined || entry.topics.includes(options.topic)))
    .map(({ content: _content, ...artifact }) => artifact)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return { artifacts }
}

export const mockArtifact = (id: string): ArtifactContent | null => entries.find((entry) => entry.id === id) ?? null
