import type { ChatArtifact, ChatArtifactContent, ChatArtifactList } from '@/api/schema'
import { mockArtifact, qaBatch } from '@/api/fixtures/artifacts'

// A native chat's artifacts for the mock, shaped like `chat artifacts|artifact --json`: one per source,
// so the row above the composer shows every mark, and megabrain ones with equal or near titles, each
// its own chip. The megabrain ones keep their earlier revisions, read with `--revision`. Only the
// mock's original chat has them; each message sent there updates the Codex plan a moment later, the
// way an agent edits an artifact mid-conversation.

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const claudeArtifact = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Onboarding steps</title>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #faf9f5; color: #1f1e1d; }
  main { max-width: 640px; margin: 0 auto; padding: 40px 32px; }
  h1 { font-size: 26px; letter-spacing: -.01em; margin: 0 0 6px; }
  p { color: #6b6a65; margin: 0 0 28px; }
  ol { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
  li { display: flex; gap: 14px; align-items: flex-start; background: #fff; border: 1px solid #e8e6dc; border-radius: 12px; padding: 14px 16px; }
  b { display: grid; place-items: center; flex: none; width: 26px; height: 26px; border-radius: 50%; background: #d97757; color: #fff; font-size: 13px; }
  span { line-height: 1.45; }
</style>
</head>
<body>
<main>
  <h1>Onboarding, four steps</h1>
  <p>Down from seven. Each step asks one thing.</p>
  <ol>
    <li><b>1</b><span><strong>Pick the agents</strong> megabrain should configure.</span></li>
    <li><b>2</b><span><strong>Choose the modules</strong>: browser, simulators, hooks.</span></li>
    <li><b>3</b><span><strong>Review the plan</strong> before anything is written.</span></li>
    <li><b>4</b><span><strong>Install</strong>, with progress per module.</span></li>
  </ol>
</main>
</body>
</html>
`

const codexPlan = (steps: number) => `# Tidy the onboarding steps

Fold the seven onboarding screens into four, keep every choice, run the web tests.

## Steps

${Array.from({ length: steps }, (_, index) => `${index + 1}. ${['Read the current step components', 'Merge agents and skills into one screen', 'Move the module picker after agents', 'Show the install plan before writing', 'Run pnpm --filter web test', 'Update the onboarding snapshots', 'Note the change in the changelog'][index % 7]}`).join('\n')}

## Notes

- The plan screen stays read-only; nothing is written until Install.
- Keyboard order follows the visual order on every step.
`

const agyNotes = `agy · session notes

  steps/agents.tsx      merged with skills.tsx
  steps/modules.tsx     now step 2
  steps/plan.tsx        unchanged
  steps/install.tsx     progress per module

tests: 48 passed, 0 failed (pnpm --filter web test)
`

const pipeline = mockArtifact('art-20261017-a1b2c3d4')
const lanePlan = mockArtifact('art-20261017-0f1e2d3c')
const qaOlder = mockArtifact('art-20261017-qa0older')
const qaNewer = mockArtifact('art-20261017-qa1newer')

type Entry = { artifact: ChatArtifact; content: string | null; reason?: string }

const original = 'chat-0001'
let planSteps = 4

const entries: Entry[] = [
  { artifact: { id: 'codex-plan-onboarding', source: 'codex-plan', title: 'Tidy the onboarding steps', format: 'markdown', updatedAt: ago(2), revision: 4, editable: false }, content: codexPlan(planSteps) },
  { artifact: { id: 'claude-artifact-steps', source: 'claude-artifact', title: 'Onboarding steps', format: 'html', updatedAt: ago(9), revision: 2, editable: false }, content: claudeArtifact },
  { artifact: { id: 'claude-design-onboarding', source: 'claude-design', title: 'Onboarding redesign', format: 'url', url: 'https://claude.ai/design/p/onboarding-redesign', updatedAt: ago(18), revision: null, editable: false }, content: null, reason: 'Claude Design keeps the project on claude.ai' },
  { artifact: { id: 'art-20261017-qa1newer', source: 'megabrain', title: 'Leva de correções do QA Social', kind: qaNewer?.kind, format: 'markdown', path: qaNewer?.path, updatedAt: ago(3), revision: 3, editable: false }, content: qaNewer?.content ?? null },
  { artifact: { id: 'art-20261017-qa0older', source: 'megabrain', title: 'Leva de correções do QA Social', kind: qaOlder?.kind, format: 'markdown', path: qaOlder?.path, updatedAt: ago(24), revision: 2, editable: false }, content: qaOlder?.content ?? null },
  {
    artifact: { id: 'art-20261017-a1b2c3d4', source: 'megabrain', title: 'Knowledge pipeline', kind: pipeline?.kind, format: 'html', path: pipeline?.path, updatedAt: ago(26), revision: 3, editable: false },
    content: pipeline?.content ?? null,
  },
  // Two of a chat's artifacts whose titles differ only by a qualifier: still two artifacts, two chips.
  { artifact: { id: 'art-20261017-e82e7a18', source: 'megabrain', title: 'Leva de correções do QA Social — fluxo', kind: 'diagram', format: 'html', updatedAt: ago(60), revision: 3, editable: false }, content: pipeline?.content ?? null },
  { artifact: { id: 'art-20261017-6b1338f8', source: 'megabrain', title: 'Leva de correções do QA Social', kind: 'doc', format: 'markdown', updatedAt: ago(120), revision: 1, editable: false }, content: qaBatch(1, 0) },
  { artifact: { id: 'agy-notes', source: 'agy', title: 'Session notes', format: 'text', updatedAt: ago(70), revision: null, editable: false }, content: agyNotes },
  { artifact: { id: 'art-20261017-0f1e2d3c', source: 'megabrain', title: 'Artifacts lane', kind: lanePlan?.kind, format: 'markdown', path: lanePlan?.path, updatedAt: ago(95), revision: 1, editable: false }, content: lanePlan?.content ?? null },
  { artifact: { id: 'grok-research', source: 'grok', title: 'Onboarding research', format: 'text', updatedAt: ago(300), revision: 1, editable: false }, content: 'Three of five first-run sessions stopped at the module picker.\nNone stopped at the plan.\n' },
]

const newestFirst = (left: Entry, right: Entry) => right.artifact.updatedAt.localeCompare(left.artifact.updatedAt)

export function mockChatArtifacts(chatId: string): ChatArtifactList {
  return { artifacts: chatId === original ? entries.slice().sort(newestFirst).map((entry) => entry.artifact) : [] }
}

/** The artifact's current content, or the revision named; null for an artifact or revision not kept. */
export function mockChatArtifact(chatId: string, artifactId: string, revision?: number): ChatArtifactContent | null {
  const entry = chatId === original ? entries.find((candidate) => candidate.artifact.id === artifactId) : undefined
  if (entry === undefined) return null
  if (revision !== undefined && revision !== entry.artifact.revision) {
    // megabrain keeps the versions it filed; the other sources keep none.
    const listed = entry.artifact.source === 'megabrain' ? mockArtifact(artifactId, revision) : null
    if (listed === null) return null
    return { artifact: { ...entry.artifact, title: listed.title, updatedAt: listed.updatedAt, revision }, content: listed.content, updatedAt: listed.updatedAt }
  }
  return { artifact: entry.artifact, content: entry.content, updatedAt: entry.artifact.updatedAt, ...(entry.reason === undefined ? {} : { reason: entry.reason }) }
}

/** The agent adds a step to its plan: a new revision, now. False for a chat with no artifacts. */
export function touchMockChatArtifact(chatId: string): boolean {
  const entry = chatId === original ? entries.find((candidate) => candidate.artifact.id === 'codex-plan-onboarding') : undefined
  if (entry === undefined) return false
  planSteps += 1
  entry.artifact = { ...entry.artifact, updatedAt: new Date().toISOString(), revision: (entry.artifact.revision ?? 0) + 1 }
  entry.content = codexPlan(planSteps)
  return true
}
