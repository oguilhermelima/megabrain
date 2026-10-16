// GitHub's state glyphs, drawn on the 16-unit grid the rest of the app's icons use.

type IconProps = { size?: number; className?: string }

function Svg({ size = 16, className, children, filled }: IconProps & { children: React.ReactNode; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill={filled === true ? 'currentColor' : 'none'}
      stroke={filled === true ? 'none' : 'currentColor'}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  )
}

export function PullRequestIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V6.5a2 2 0 0 0-2-2H7.5" />
      <path d="m9 3 -1.5 1.5L9 6" />
    </Svg>
  )
}

export function DraftPullRequestIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 3.2v.6M12 6.2v.6M12 9.2v.6" />
    </Svg>
  )
}

export function MergedIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="8" r="1.6" />
      <path d="M4 5.1v5.8M4 5.5c0 2.2 2.4 2.5 6.4 2.5" />
    </Svg>
  )
}

export function ClosedPullRequestIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V8M10.3 2.8l3.4 3.4M13.7 2.8l-3.4 3.4" />
    </Svg>
  )
}

export function IssueIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function ClosedIssueIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="m5.4 8.2 1.8 1.8 3.5-3.7" />
    </Svg>
  )
}

export function CommentIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 4.2c0-.9.7-1.7 1.7-1.7h7.6c.9 0 1.7.8 1.7 1.7v5c0 .9-.8 1.7-1.7 1.7H7.2L4.4 13.3v-2.4h-.2c-1 0-1.7-.8-1.7-1.7v-5Z" />
    </Svg>
  )
}

export function CheckPassIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m3.5 8.5 3 3 6-7" />
    </Svg>
  )
}

export function CheckFailIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
    </Svg>
  )
}

export function CheckPendingIcon(props: IconProps) {
  return (
    <Svg {...props} filled>
      <circle cx="8" cy="8" r="3.2" />
    </Svg>
  )
}

export function CheckSkippedIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.2 11.8 11.8 4.2" />
    </Svg>
  )
}

export function MilestoneIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2v2M8 9.5V14M3 4h8.5L13.5 6.7 11.5 9.5H3V4Z" />
    </Svg>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />
    </Svg>
  )
}

export function LinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5" />
    </Svg>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  )
}

export function MaximiseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
    </Svg>
  )
}

export function ChevronIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 4 4 4-4 4" />
    </Svg>
  )
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
      <path d="M10.5 3.5v-.3a1.2 1.2 0 0 0-1.2-1.2H3.7a1.2 1.2 0 0 0-1.2 1.2v5.6c0 .7.5 1.2 1.2 1.2H4" />
    </Svg>
  )
}

export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props} filled>
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </Svg>
  )
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8h9.5M9 4.5 12.5 8 9 11.5" />
    </Svg>
  )
}

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 2.5h5l3 3v8H4v-11Z" />
      <path d="M9 2.5v3h3" />
    </Svg>
  )
}

export function BranchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5" r="1.5" />
      <path d="M4.5 5v6M11.5 6.5c0 2.6-3.6 2.4-6.4 4.4" />
    </Svg>
  )
}

export function ReviewIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1.8 8s2.3-4.3 6.2-4.3S14.2 8 14.2 8 11.9 12.3 8 12.3 1.8 8 1.8 8Z" />
      <circle cx="8" cy="8" r="1.8" />
    </Svg>
  )
}

/** A changed file's status as GitHub draws it: a rounded square with a plus, dot, minus or arrow. */
export function FileStatusIcon({ status, ...props }: IconProps & { status: 'added' | 'modified' | 'removed' | 'renamed' }) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.6" />
      {status === 'added' && <path d="M8 5.5v5M5.5 8h5" />}
      {status === 'modified' && <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />}
      {status === 'removed' && <path d="M5.5 8h5" />}
      {status === 'renamed' && <path d="M5.5 8h5M8.5 6l2 2-2 2" />}
    </Svg>
  )
}
