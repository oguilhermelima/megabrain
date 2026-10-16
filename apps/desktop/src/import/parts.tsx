import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { pictureUrl } from '@/advanced/appearance-model'
import { githubAvatarUrl, projectColor, projectInitials } from '@/advanced/picture-model'
import { relativeAge } from '@/advanced/projects-model'
import { native } from '@/lib/surface'

const toAsset = native ? convertFileSrc : null

/**
 * A repository's picture before it is a project: the one the person chose, else its GitHub
 * owner's avatar, else coloured initials — the same fallbacks a project row uses.
 */
export function RepoMark({ name, remote, picture = null, color = null, size = 'row' }: { name: string; remote: string | null; picture?: string | null; color?: string | null; size?: 'row' | 'large' }) {
  const chosen = picture === null ? null : pictureUrl(picture, toAsset)
  const url = chosen ?? githubAvatarUrl(remote)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])
  const box = size === 'large' ? 'size-14 rounded-[16px] text-[19px]' : 'size-8 rounded-[10px] text-[12px]'
  if (url !== null && !failed) {
    return <img src={url} alt="" draggable={false} onError={() => setFailed(true)} className={`${box} shrink-0 bg-white/[0.06] ${chosen === null ? 'object-contain' : 'object-cover'}`} />
  }
  return (
    <span aria-hidden="true" style={{ backgroundColor: color ?? projectColor(name) }} className={`${box} grid shrink-0 place-items-center font-bold tracking-[0.02em] text-white`}>
      {projectInitials(name)}
    </span>
  )
}

/** "3h ago" for an ISO time, "just now" under a minute, empty without one. */
export function ago(iso: string | null): string {
  const age = relativeAge(iso)
  if (age === '') return ''
  return age === 'now' ? 'just now' : `${age} ago`
}

/** A path with the home folder written as ~. */
export function tildePath(path: string, home: string | null): string {
  if (home === null || home === '') return path
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export function Chip({ children, title, tone = 'plain' }: { children: ReactNode; title?: string; tone?: 'plain' | 'accent' }) {
  return (
    <span title={title} className={`inline-flex h-[20px] max-w-[14rem] shrink-0 items-center gap-1 truncate rounded-[7px] border px-1.5 text-[11.5px] leading-none ${tone === 'accent' ? 'border-accent/40 text-accent' : 'border-white/[0.14] text-ink-300'}`}>
      {children}
    </span>
  )
}

export function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="5" cy="3.5" r="1.5" />
      <circle cx="5" cy="12.5" r="1.5" />
      <circle cx="11" cy="5.5" r="1.5" />
      <path d="M5 5v6M11 7c0 2.5-3 2.5-6 4" />
    </svg>
  )
}

export function FolderIcon({ className = 'size-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2.2h8.6A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
    </svg>
  )
}

export function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  )
}

export function StarIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3 shrink-0" fill="currentColor" aria-hidden="true">
      <path d="M8 1.8l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.2l-3.7 2.1.8-4.2L2 6.2l4.2-.5z" />
    </svg>
  )
}

/** A search box: the magnifier, the input and a hint of the keys it answers to. */
export function SearchField({ value, onChange, onKeyDown, placeholder, label, inputRef, autoFocus = false }: { value: string; onChange: (value: string) => void; onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void; placeholder: string; label: string; inputRef?: Ref<HTMLInputElement>; autoFocus?: boolean }) {
  return (
    <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-4 text-ink-400 focus-within:border-accent/60">
      <SearchIcon />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[14px] text-ink-100 outline-none placeholder:text-ink-500"
      />
    </label>
  )
}

/** Keys a list answers to, for the footer. */
export function KeyHint({ keys, children }: { keys: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-500">
      <kbd className="rounded-[5px] border border-white/[0.14] px-1.5 font-sans text-[11px] leading-[18px] text-ink-300">{keys}</kbd>
      {children}
    </span>
  )
}
