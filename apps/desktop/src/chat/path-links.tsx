import { Children, createContext, useContext, type ReactNode } from 'react'
import { pathSegments, type FileTarget } from '@/code/chat-paths'

/** Where a chat's file paths open: the worktree they must sit under, and what a click does. A link
 * to a local file may also sit under any listed project or worktree in `roots`; `openFile` opens it. */
export interface PathLinks {
  root: string | null
  open: (path: string, line: number | null) => void
  roots: readonly string[]
  openFile: (target: FileTarget) => void
}

export const PathLinksContext = createContext<PathLinks | null>(null)

/** Text with every path under the chat's worktree turned into a link that opens it in Code. */
export function LinkedText({ text }: { text: string }) {
  const links = useContext(PathLinksContext)
  if (links === null) return <>{text}</>
  return (
    <>
      {pathSegments(text, links.root).map((segment, index) =>
        segment.kind === 'text' ? (
          segment.text
        ) : (
          <button
            key={index}
            type="button"
            onClick={() => links.open(segment.path, segment.line)}
            title={`Open in Code: ${segment.text}`}
            className="cursor-pointer text-accent underline decoration-dotted underline-offset-2 select-text hover:decoration-solid"
          >
            {segment.text}
          </button>
        ),
      )}
    </>
  )
}

/** Links the plain-text children of a rendered element, leaving nested elements to their own renderer. */
export function Linked({ children }: { children?: ReactNode }) {
  return <>{Children.map(children, (child) => (typeof child === 'string' ? <LinkedText text={child} /> : child))}</>
}
