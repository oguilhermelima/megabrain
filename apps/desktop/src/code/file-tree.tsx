import type { TreeNode } from '@/code/code-model'

function Row({
  node,
  depth,
  filterActive,
  matches,
  expanded,
  onToggleDir,
  onSelectFile,
  selectedPath,
}: {
  node: TreeNode
  depth: number
  filterActive: boolean
  matches: Set<string>
  expanded: Set<string>
  onToggleDir: (path: string) => void
  onSelectFile: (path: string) => void
  selectedPath: string | null
}) {
  if (filterActive && !matches.has(node.path)) return null
  const indent = { paddingLeft: `${depth * 16 + 12}px` }

  if (node.kind === 'file') {
    return (
      <button
        type="button"
        onClick={() => onSelectFile(node.path)}
        style={indent}
        className={`block w-full truncate rounded-lg py-1 pr-3 text-left text-[13px] ${
          selectedPath === node.path ? 'bg-white/[0.1] text-ink-100' : 'text-ink-300 hover:bg-white/[0.06] hover:text-ink-100'
        }`}
        title={node.path}
      >
        {node.name}
      </button>
    )
  }

  const open = filterActive || expanded.has(node.path)
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleDir(node.path)}
        style={indent}
        className="flex w-full items-center gap-1.5 truncate rounded-lg py-1 pr-3 text-left text-[13px] font-medium text-ink-200 hover:bg-white/[0.06]"
        title={node.path}
      >
        <span className="inline-block w-3 text-ink-500">{open ? '▾' : '▸'}</span>
        {node.name}
      </button>
      {open &&
        node.children.map((child) => (
          <Row
            key={child.path}
            node={child}
            depth={depth + 1}
            filterActive={filterActive}
            matches={matches}
            expanded={expanded}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
            selectedPath={selectedPath}
          />
        ))}
    </div>
  )
}

export function FileTree({
  nodes,
  filterActive,
  matches,
  expanded,
  onToggleDir,
  onSelectFile,
  selectedPath,
}: {
  nodes: TreeNode[]
  filterActive: boolean
  matches: Set<string>
  expanded: Set<string>
  onToggleDir: (path: string) => void
  onSelectFile: (path: string) => void
  selectedPath: string | null
}) {
  return (
    <div className="py-1">
      {nodes.map((node) => (
        <Row
          key={node.path}
          node={node}
          depth={0}
          filterActive={filterActive}
          matches={matches}
          expanded={expanded}
          onToggleDir={onToggleDir}
          onSelectFile={onSelectFile}
          selectedPath={selectedPath}
        />
      ))}
    </div>
  )
}
