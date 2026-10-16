// What the empty chat says: the headline over the orb, the line under it and the suggestions.

const basename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

const agentLabels: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok', agy: 'agy' }

/** An agent's name as the person reads it; one the app does not know keeps its id. */
export const agentLabel = (agent: string) => agentLabels[agent] ?? agent

/** The headline and the quiet line under it, for an agent in a worktree. */
export function emptyChatText(agent: string, cwd: string): { headline: string; detail: string } {
  return {
    headline: `What should we build in ${basename(cwd)}?`,
    detail: `${agentLabel(agent)} can read, change and run the code here. Describe a task, or start from one of these.`,
  }
}

export type SuggestionIcon = 'explain' | 'bugs' | 'tests' | 'pulls'

export interface ChatSuggestion {
  icon: SuggestionIcon
  /** What fills the composer. */
  title: string
  hint: string
}

/** The suggestions for a worktree; the tests one names a file it changed, when there is one. */
export function chatSuggestions(changedFile: string | null): ChatSuggestion[] {
  return [
    { icon: 'explain', title: 'Explain this repo', hint: 'How it is laid out and where to start' },
    { icon: 'bugs', title: 'Find bugs in the last commit', hint: 'Read the latest change for mistakes' },
    {
      icon: 'tests',
      title: changedFile === null ? 'Write tests for the code I changed last' : `Write tests for ${changedFile}`,
      hint: changedFile === null ? 'Cover what changed most recently' : 'Cover the file changed most recently',
    },
    { icon: 'pulls', title: 'Summarise the open pull requests', hint: 'Where each one stands' },
  ]
}
