import type { Project } from '@/api/schema'

export type SourceResult = { ok: true; url: string } | { ok: false; error: string }

const githubUrl = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/
const ownerName = /^[\w.-]+\/[\w.-]+$/

/** Accepts a github.com URL or an `owner/name` shorthand; normalizes either to a clone URL. */
export function parseGithubSource(input: string): SourceResult {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: false, error: 'Enter a URL or owner/name.' }
  const withoutGit = trimmed.replace(/\.git$/, '')
  const urlMatch = githubUrl.exec(withoutGit)
  if (urlMatch !== null) return { ok: true, url: `https://github.com/${urlMatch[1]}/${urlMatch[2]}` }
  if (/^https?:\/\//.test(trimmed)) return { ok: false, error: 'Enter a github.com repository URL.' }
  if (ownerName.test(trimmed)) return { ok: true, url: `https://github.com/${trimmed}` }
  return { ok: false, error: 'Enter a URL or owner/name.' }
}

/** The parent folder of the first known project, used as the clone destination's default. */
export function defaultDestination(projects: Project[]): string | null {
  const first = projects[0]
  if (first === undefined) return null
  const parts = first.path.split('/')
  parts.pop()
  const parent = parts.join('/')
  return parent === '' ? null : parent
}
