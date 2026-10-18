import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { Children, Fragment, isValidElement, useContext, useMemo, useRef, useState, type AnchorHTMLAttributes, type ImgHTMLAttributes, type ReactNode } from 'react'
import { MenuIconGlyph } from '@/components/menu-icons'
import { api } from '@/api'
import { Linked, PathLinksContext } from '@/chat/path-links'
import { localFileTarget } from '@/code/chat-paths'
import { openableUrl } from '@/lib/external'
import { isShellFence, shellLines, type ShellToken, type ShellTokenKind } from '@/chat/shell-tokens'

// A web or mail link opens in the system's default app, and a link to a local file under a listed
// project or worktree opens in Code; any other target stays inert text that only shows where it
// points on hover. Either way the transcript's right-click menu reads data-link.
function ExternalLink({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const links = useContext(PathLinksContext)
  const address = href === undefined ? null : openableUrl(href)
  const file = address !== null || href === undefined || links === null ? null : localFileTarget(href, links.root, links.roots)
  if (file !== null && links !== null) {
    const openFile = () => links.openFile(file)
    return (
      <span
        role="link"
        tabIndex={0}
        title={`Open in Code: ${href}`}
        data-link={href}
        onClick={openFile}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          openFile()
        }}
        className="cursor-pointer text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid"
      >
        {children}
      </span>
    )
  }
  if (address === null) {
    return (
      <span title={href} data-link={href} className="cursor-default text-accent underline decoration-dotted underline-offset-2">
        {children}
      </span>
    )
  }
  // No href: a click on a real anchor would navigate the web view itself.
  const open = () => void api.openUrl(address).catch(() => {})
  return (
    <span
      role="link"
      tabIndex={0}
      title={address}
      data-link={address}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        open()
      }}
      className="cursor-pointer text-accent underline underline-offset-2 hover:decoration-2"
    >
      {children}
    </span>
  )
}

// The fence's language, from the class react-markdown gives its code element (language-tsx).
function fenceLanguage(node: unknown): string | null {
  const code = (node as { children?: { properties?: { className?: unknown } }[] } | undefined)?.children?.[0]
  const classes = code?.properties?.className
  const found = Array.isArray(classes) ? classes.find((name): name is string => typeof name === 'string' && name.startsWith('language-')) : undefined
  return found === undefined ? null : found.slice('language-'.length)
}

// The fence's text, from the code element react-markdown puts inside its pre.
function fenceText(children: ReactNode): string | null {
  const code = Children.toArray(children)[0]
  if (!isValidElement<{ children?: ReactNode }>(code)) return null
  const parts = Children.toArray(code.props.children)
  return parts.every((part) => typeof part === 'string') ? parts.join('') : null
}

// The editors' One Dark colours, so a command reads the same here as in Code.
const shellColour: Record<Exclude<ShellTokenKind, 'text'>, string> = {
  prompt: 'text-ink-400',
  command: 'text-[#61afef]',
  flag: 'text-[#d19a66]',
  string: 'text-[#98c379]',
  variable: 'text-[#e06c75]',
  operator: 'text-[#56b6c2]',
  comment: 'text-[#7d8799] italic',
}

/** A shell block's lines, coloured token by token; its text is the fence's, character for character. */
function ShellCode({ lines }: { lines: ShellToken[][] }) {
  return (
    <code className="font-mono text-ink-100">
      {lines.map((tokens, row) => (
        <Fragment key={row}>
          {row > 0 && '\n'}
          {tokens.map((token, index) => (token.kind === 'text' ? <Fragment key={index}>{token.text}</Fragment> : <span key={index} className={shellColour[token.kind]}>{token.text}</span>))}
        </Fragment>
      ))}
    </code>
  )
}

/**
 * A fenced block: mono at the chat's code size on its own surface, long lines wrapped, with its language and a
 * copy button. A shell block colours its commands.
 */
function CodeBlock({ node, children, ...props }: React.ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const language = fenceLanguage(node)
  const shell = useMemo(() => {
    const text = fenceText(children)
    return text !== null && isShellFence(language, text) ? shellLines(text) : null
  }, [children, language])
  const copy = () => {
    const text = pre.current?.textContent ?? ''
    void navigator.clipboard.writeText(text.replace(/\n$/, '')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }, () => {})
  }
  return (
    <div className="group/code relative overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.035]">
      <div className="flex h-8 items-center justify-between border-b border-white/[0.06] pr-1.5 pl-4 text-chat-label text-ink-400">
        <span className="font-mono">{language ?? 'code'}</span>
        <button type="button" onClick={copy} title="Copy code" className="flex items-center gap-1.5 rounded-md px-2 py-1 text-chat-small hover:bg-white/[0.07] hover:text-ink-200">
          <MenuIconGlyph icon="copy" />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={pre} className="px-4 py-3 font-mono text-chat-code whitespace-pre-wrap [overflow-wrap:anywhere]" {...props}>
        {shell === null ? children : <ShellCode lines={shell} />}
      </pre>
    </div>
  )
}

const components = {
  a: ExternalLink,
  // Text-bearing elements link the file paths in their text (see path-links.tsx).
  p: ({ children, ...props }: React.ComponentPropsWithoutRef<'p'>) => (
    <p className="whitespace-pre-wrap" {...props}>
      <Linked>{children}</Linked>
    </p>
  ),
  ul: (props: React.ComponentPropsWithoutRef<'ul'>) => <ul className="list-disc space-y-1 pl-6 marker:text-ink-400 [&_ol]:mt-1.5 [&_ul]:mt-1.5" {...props} />,
  ol: (props: React.ComponentPropsWithoutRef<'ol'>) => <ol className="list-decimal space-y-1 pl-6 marker:text-ink-400 [&_ol]:mt-1.5 [&_ul]:mt-1.5" {...props} />,
  li: ({ children, ...props }: React.ComponentPropsWithoutRef<'li'>) => (
    <li className="pl-1 [&>p+p]:mt-1.5" {...props}>
      <Linked>{children}</Linked>
    </li>
  ),
  strong: ({ children, ...props }: React.ComponentPropsWithoutRef<'strong'>) => (
    <strong className="font-semibold text-ink-100" {...props}>
      <Linked>{children}</Linked>
    </strong>
  ),
  em: ({ children, ...props }: React.ComponentPropsWithoutRef<'em'>) => (
    <em {...props}>
      <Linked>{children}</Linked>
    </em>
  ),
  h1: (props: React.ComponentPropsWithoutRef<'h1'>) => <h1 className="pt-3 text-chat-h1 font-semibold tracking-[-0.015em] text-ink-100" {...props} />,
  h2: (props: React.ComponentPropsWithoutRef<'h2'>) => <h2 className="pt-2.5 text-chat-h2 font-semibold tracking-[-0.01em] text-ink-100" {...props} />,
  h3: (props: React.ComponentPropsWithoutRef<'h3'>) => <h3 className="pt-1.5 text-chat-h3 font-semibold text-ink-100" {...props} />,
  h4: (props: React.ComponentPropsWithoutRef<'h4'>) => <h4 className="pt-1 font-semibold text-ink-100" {...props} />,
  blockquote: (props: React.ComponentPropsWithoutRef<'blockquote'>) => (
    <blockquote className="space-y-2 border-l-[3px] border-white/15 pl-4 text-ink-300" {...props} />
  ),
  hr: (props: React.ComponentPropsWithoutRef<'hr'>) => <hr className="my-5 border-white/10" {...props} />,
  code: ({ node: _node, className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { node?: unknown }) =>
    className?.includes('language-') ? (
      <code className={`${className} font-mono text-ink-100`} {...props}>
        {children}
      </code>
    ) : (
      <code className="rounded-[5px] border border-white/[0.07] bg-white/[0.06] px-[5px] py-px font-mono text-[0.875em] text-ink-100 [pre_&]:border-0 [pre_&]:bg-transparent [pre_&]:p-0 [pre_&]:text-[1em]" {...props}>
        <Linked>{children}</Linked>
      </code>
    ),
  pre: CodeBlock,
  // A wide table scrolls inside its frame rather than widening the message.
  table: (props: React.ComponentPropsWithoutRef<'table'>) => (
    <div className="w-fit max-w-full overflow-x-auto rounded-xl border border-white/[0.08]">
      <table className="border-collapse text-chat-ui" {...props} />
    </div>
  ),
  th: (props: React.ComponentPropsWithoutRef<'th'>) => (
    <th className="border-b border-white/[0.08] bg-white/[0.04] px-3 py-2 text-left font-semibold text-ink-200 [&:not(:last-child)]:border-r" {...props} />
  ),
  td: ({ children, ...props }: React.ComponentPropsWithoutRef<'td'>) => (
    <td className="border-white/[0.06] px-3 py-2 align-top text-ink-300 [&:not(:last-child)]:border-r [tr:not(:last-child)_&]:border-b" {...props}>
      <Linked>{children}</Linked>
    </td>
  ),
  input: (props: React.ComponentPropsWithoutRef<'input'>) =>
    props.type === 'checkbox' ? <input {...props} disabled className="mr-1.5 accent-accent" /> : <input {...props} />,
}

// A sent message's image slots (user-images.ts imageSlot): a span whose data-image survives sanitizing.
const imageSlotSchema = { ...defaultSchema, attributes: { ...defaultSchema.attributes, span: [...(defaultSchema.attributes?.span ?? []), 'dataImage'] } }

/**
 * Markdown; with `image`, each image slot in the text renders as what it returns for that image's
 * index, with `picture`, each picture (markdown or HTML img) renders as what it returns, and
 * `elements` replaces how other elements render (a code block with a copy button, say).
 */
export function MarkdownText({ text, className = '', image, picture, elements }: { text: string; className?: string; image?: (index: number) => ReactNode; picture?: (props: ImgHTMLAttributes<HTMLImageElement>) => ReactNode; elements?: Components }) {
  // Kept while `picture` and `elements` are the same, or every render would remount each picture.
  const pictured = useMemo(() => {
    const base = elements === undefined ? components : { ...components, ...elements }
    return picture === undefined ? base : { ...base, img: ({ node: _node, ...props }: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) => picture(props) }
  }, [picture, elements])
  const slotted =
    image === undefined
      ? pictured
      : {
          ...pictured,
          span: ({ node: _node, ...props }: React.ComponentPropsWithoutRef<'span'> & { node?: unknown; 'data-image'?: string }) => {
            const index = props['data-image'] === undefined ? Number.NaN : Number(props['data-image'])
            return Number.isInteger(index) ? image(index) : <span {...props} />
          },
        }
  return (
    // The size comes from where it shows: the transcript sets the chat's (text-chat), a page passes its own.
    <div className={`space-y-3 ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, image === undefined ? defaultSchema : imageSlotSchema]]} components={slotted}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
