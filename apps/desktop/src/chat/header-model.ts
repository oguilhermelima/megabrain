// What a chat's top bar says: the title on one line, nothing else. The agent shows as the mark
// beside it; its branch, model, project and folder are spread across the window already (the
// composer, the sidebar, a split's shared bar).

/** A blank title reads New chat. */
export function headerTitle(title: string): string {
  return title.trim() === '' ? 'New chat' : title
}
