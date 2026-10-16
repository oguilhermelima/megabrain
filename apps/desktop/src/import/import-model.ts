// What the Import project dialog decides without touching the screen: which suggestions to show,
// what a chosen folder will look like once imported, where a clone lands, and which GitHub
// repositories match. ImportProject.tsx draws it.

import type { DiscoveredRepository, GithubRepository, Project, ProjectScripts } from '@/api/schema'
import type { ProjectAppearancePatch } from '@/api/adapter'
import { isHexColor } from '@/advanced/appearance-model'

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

function parent(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  parts.pop()
  return parts.join('/')
}

/** Where a clone goes unless the person picks another folder: beside a project under ~/Workspaces, else ~/Workspaces. */
export function defaultDestination(projects: Project[], home: string): string {
  const workspaces = `${home.replace(/\/+$/, '')}/Workspaces`
  const inside = projects.find((project) => project.path.startsWith(`${workspaces}/`))
  return inside === undefined ? workspaces : parent(inside.path)
}

/** The folder a clone of url creates inside destination. */
export function cloneTarget(destination: string, url: string): string {
  const name = url.replace(/\/+$/, '').replace(/\.git$/, '').split('/').at(-1) ?? ''
  return `${destination.replace(/\/+$/, '')}/${name}`
}

/** Host and path of a remote in any of git's URL forms, without .git; null when it is not one. */
function remoteParts(remote: string): { host: string; path: string } | null {
  const trimmed = remote.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const url = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(trimmed)
  if (url?.[1] !== undefined && url[2] !== undefined) return { host: url[1].toLowerCase(), path: url[2] }
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed)
  if (scp?.[1] !== undefined && scp[2] !== undefined) return { host: scp[1].toLowerCase(), path: scp[2] }
  return null
}

/** owner/name in lower case for a github.com remote; null for another host or none. */
export function githubName(remote: string | null): string | null {
  if (remote === null) return null
  const parts = remoteParts(remote)
  return parts === null || parts.host !== 'github.com' ? null : parts.path.toLowerCase()
}

/** A remote as a person reads it: owner/name on GitHub, host/path elsewhere; null for none. */
export function remoteLabel(remote: string | null): string | null {
  if (remote === null) return null
  const parts = remoteParts(remote)
  if (parts === null) return remote
  return parts.host === 'github.com' ? parts.path : `${parts.host}/${parts.path}`
}

/** The scan's suggestions not registered since, matching the query on name, path or remote; the scan's order is kept. */
export function visibleSuggestions(found: DiscoveredRepository[], registered: string[], query: string): DiscoveredRepository[] {
  const known = new Set(registered)
  const needle = query.trim().toLowerCase()
  return found.filter((entry) => !known.has(entry.path) && (needle === '' || [entry.name, entry.path, entry.remote ?? ''].some((text) => text.toLowerCase().includes(needle))))
}

/** Adds a path to the chosen ones, or takes it out when it is already there. */
export function toggleChoice(chosen: readonly string[], path: string): string[] {
  return chosen.includes(path) ? chosen.filter((entry) => entry !== path) : [...chosen, path]
}

/** The row an arrow key moves to: clamped to the list, the first row from none, -1 when the list is empty. */
export function moveFocus(index: number, delta: number, length: number): number {
  if (length === 0) return -1
  if (index < 0) return 0
  return Math.max(0, Math.min(length - 1, index + delta))
}

/** A folder about to be imported and how the person dressed it before importing. */
export interface ImportPreview {
  path: string
  folderName: string
  name: string
  color: string | null
  picture: string | null
  remote: string | null
  branch: string | null
}

/** The preview of a chosen folder, from what the scan knew about it when it did. */
export function previewFromPath(path: string, found: DiscoveredRepository[]): ImportPreview {
  const clean = path.replace(/\/+$/, '')
  const known = found.find((entry) => entry.path === clean)
  const folderName = clean.split('/').at(-1) ?? clean
  return { path: clean, folderName, name: folderName, color: null, picture: null, remote: known?.remote ?? null, branch: known?.branch ?? null }
}

/** What to save as the project's appearance once imported; null when the person changed nothing. */
export function previewPatch(preview: ImportPreview): ProjectAppearancePatch | null {
  const patch: ProjectAppearancePatch = {}
  const name = preview.name.trim()
  if (name !== '' && name !== preview.folderName) patch.name = name
  if (preview.color !== null && isHexColor(preview.color)) patch.color = preview.color
  if (preview.picture !== null) patch.picture = preview.picture
  return Object.keys(patch).length === 0 ? null : patch
}

export interface ScriptLine {
  name: 'run' | 'build' | 'install'
  command: string
  source: 'saved' | 'detected'
}

/** The run, build and install commands megabrain found, in that order, leaving out the missing ones. */
export function scriptLines(scripts: ProjectScripts | null): ScriptLine[] {
  if (scripts === null) return []
  return (['run', 'build', 'install'] as const).flatMap((name) => {
    const script = scripts.scripts[name]
    return script === null ? [] : [{ name, command: script.command, source: script.source }]
  })
}

/** Imports run side by side; this splits the paths that made it from those that failed, each with its reason. */
export function settleImports(paths: string[], results: PromiseSettledResult<unknown>[]): { imported: string[]; failed: { path: string; error: string }[] } {
  const imported: string[] = []
  const failed: { path: string; error: string }[] = []
  results.forEach((result, index) => {
    const path = paths[index] ?? ''
    if (result.status === 'fulfilled') imported.push(path)
    else failed.push({ path, error: result.reason instanceof Error ? result.reason.message : String(result.reason) })
  })
  return { imported, failed }
}

/** GitHub repositories of one owner (or all), matching the query on name, description or language, recently updated first. */
export function visibleGithub(repositories: GithubRepository[], query: string, owner: string | null): GithubRepository[] {
  const needle = query.trim().toLowerCase()
  return repositories
    .filter((repository) => owner === null || repository.nameWithOwner.startsWith(`${owner}/`))
    .filter((repository) => needle === '' || [repository.nameWithOwner, repository.description ?? '', repository.primaryLanguage?.name ?? ''].some((text) => text.toLowerCase().includes(needle)))
    .sort((left, right) => {
      if (left.updatedAt === null || right.updatedAt === null) return Number(left.updatedAt === null) - Number(right.updatedAt === null)
      return right.updatedAt.localeCompare(left.updatedAt)
    })
}

/** Whether a registered project already has this repository as its remote. */
export function isImportedGithub(repository: GithubRepository, projects: Project[]): boolean {
  const name = repository.nameWithOwner.toLowerCase()
  return projects.some((project) => githubName(project.remote) === name)
}
