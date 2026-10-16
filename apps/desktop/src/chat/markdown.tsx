import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { AnchorHTMLAttributes } from 'react'
import { api } from '@/api'
import { Linked } from '@/chat/path-links'
import { httpsUrl } from '@/lib/external'

// An https link opens in the system's browser; any other target stays inert text that only shows
// where it points on hover.
function ExternalLink({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const address = href === undefined ? null : httpsUrl(href)
  if (address === null) {
    return (
      <span title={href} className="cursor-default text-accent underline decoration-dotted underline-offset-2">
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

const components = {
  a: ExternalLink,
  // Text-bearing elements link the file paths in their text (see path-links.tsx).
  p: ({ children, ...props }: React.ComponentPropsWithoutRef<'p'>) => (
    <p className="whitespace-pre-wrap" {...props}>
      <Linked>{children}</Linked>
    </p>
  ),
  ul: (props: React.ComponentPropsWithoutRef<'ul'>) => <ul className="list-disc space-y-0.5 pl-5" {...props} />,
  ol: (props: React.ComponentPropsWithoutRef<'ol'>) => <ol className="list-decimal space-y-0.5 pl-5" {...props} />,
  li: ({ children, ...props }: React.ComponentPropsWithoutRef<'li'>) => (
    <li {...props}>
      <Linked>{children}</Linked>
    </li>
  ),
  strong: ({ children, ...props }: React.ComponentPropsWithoutRef<'strong'>) => (
    <strong {...props}>
      <Linked>{children}</Linked>
    </strong>
  ),
  em: ({ children, ...props }: React.ComponentPropsWithoutRef<'em'>) => (
    <em {...props}>
      <Linked>{children}</Linked>
    </em>
  ),
  h1: (props: React.ComponentPropsWithoutRef<'h1'>) => <h1 className="text-[17px] font-bold text-ink-100" {...props} />,
  h2: (props: React.ComponentPropsWithoutRef<'h2'>) => <h2 className="text-[16px] font-bold text-ink-100" {...props} />,
  h3: (props: React.ComponentPropsWithoutRef<'h3'>) => <h3 className="text-[15px] font-bold text-ink-100" {...props} />,
  blockquote: (props: React.ComponentPropsWithoutRef<'blockquote'>) => (
    <blockquote className="border-l-2 border-white/15 pl-3 text-ink-400 italic" {...props} />
  ),
  code: ({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'>) =>
    className?.includes('language-') ? (
      <code className={`${className} font-mono text-[12.5px] text-ink-100`} {...props}>
        {children}
      </code>
    ) : (
      <code className="rounded-md bg-white/[0.08] px-1 py-0.5 font-mono text-[13px] text-ink-100" {...props}>
        <Linked>{children}</Linked>
      </code>
    ),
  pre: (props: React.ComponentPropsWithoutRef<'pre'>) => (
    <pre className="my-1.5 overflow-x-auto rounded-xl bg-white/[0.06] px-3 py-2" {...props} />
  ),
  table: (props: React.ComponentPropsWithoutRef<'table'>) => (
    <table className="my-1.5 border-collapse text-[13px]" {...props} />
  ),
  th: (props: React.ComponentPropsWithoutRef<'th'>) => (
    <th className="border border-white/10 px-2 py-1 text-left font-semibold text-ink-200" {...props} />
  ),
  td: ({ children, ...props }: React.ComponentPropsWithoutRef<'td'>) => (
    <td className="border border-white/10 px-2 py-1 text-ink-300" {...props}>
      <Linked>{children}</Linked>
    </td>
  ),
  input: (props: React.ComponentPropsWithoutRef<'input'>) =>
    props.type === 'checkbox' ? <input {...props} disabled className="accent-accent" /> : <input {...props} />,
}

export function MarkdownText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`space-y-1.5 text-[14px] ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, defaultSchema]]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
