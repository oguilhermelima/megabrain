// Placeholder: the code browser (file tree, read-only editor, changed files, diff) is its own piece
// of work. `root` is a worktree or repository path megabrain lists.
export function CodeView({ root, title }: { root: string; title: string; onClose: () => void }) {
  return (
    <div className="p-10 text-ink-500">
      Code for {title}: <span className="font-mono">{root}</span>
    </div>
  )
}
