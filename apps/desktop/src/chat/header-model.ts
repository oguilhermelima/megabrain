// What a chat's top bar says: the title on one line and the branch the item works on under it,
// nothing else. The agent shows as the mark beside them; its model, project and folder are spread
// across the window already (the composer, the sidebar, a split's shared bar).

export interface HeaderText {
  title: string
  /** The line under the title; null leaves the title alone, centred on the mark. */
  branch: string | null
}

/**
 * A blank title reads New chat. A slim header (under a split's shared bar) shows the title only:
 * that bar names the branch, and a split shares one only while every pane works in that worktree.
 */
export function headerText({ title, branch, slim }: { title: string; branch: string | null; slim: boolean }): HeaderText {
  const shown = branch?.trim() ?? ''
  return { title: title.trim() === '' ? 'New chat' : title, branch: slim || shown === '' ? null : shown }
}
