// How a project shows in megabrain: a display name, a colour and a picture the person chose, each
// stored by megabrain only (`settings set project-appearance`) and each falling back to what the
// repository gives — its folder name, no colour, the detected picture (picture-model.ts). The
// colour tints only the agent marks of the project's chats and sessions (agent-activity.ts).

import type { ProjectAppearance } from '@/api/schema'

interface Dressed {
  name: string
  path: string
  appearance?: ProjectAppearance
}

/** Ten mid-tone colours that read on the dark sidebar, in hue order. */
export const tintSwatches = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899']

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value)
}

export function displayName(project: Dressed): string {
  const name = project.appearance?.name?.trim() ?? ''
  return name === '' ? project.name : name
}

/** What to store for a typed name: null when it is empty or the real name, so the project follows its folder again. */
export function nameEdit(project: Dressed, typed: string): string | null {
  const name = typed.trim()
  return name === '' || name === project.name ? null : name
}

/** The colour for the project's agent marks; anything but #rrggbb is ignored, never handed to CSS. */
export function projectTint(project: Dressed): string | null {
  const color = project.appearance?.color ?? null
  return color !== null && isHexColor(color) ? color : null
}

/** megabrain's copy of the picture the person chose; null shows the detected one. */
export function customPicture(project: Dressed): string | null {
  const picture = project.appearance?.picture ?? null
  return picture === null || picture === '' ? null : picture
}

/** The image files megabrain takes as a project's picture, by extension. */
export const pictureExtensions = ['png', 'jpg', 'jpeg', 'webp', 'svg']

/** The path to take from files dropped on the picture: one image, else null. */
export function droppedPicture(paths: readonly string[]): string | null {
  const [path] = paths
  if (paths.length !== 1 || path === undefined) return null
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension !== undefined && pictureExtensions.includes(extension) ? path : null
}

/** An <img> source for a stored picture: a file path through the asset protocol, a data or https URL as it is. */
export function pictureUrl(picture: string, toAsset: ((path: string) => string) | null): string | null {
  if (/^(data:image\/|https:\/\/)/.test(picture)) return picture
  return toAsset === null ? null : toAsset(picture)
}

/** Two names in alphabetical order, ignoring case and accents. */
export function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: 'base' })
}

/** Alphabetical by display name, ignoring case and accents; the path breaks a tie so the order never flickers. */
export function compareByDisplayName(left: Dressed, right: Dressed): number {
  return compareNames(displayName(left), displayName(right)) || left.path.localeCompare(right.path)
}

/** A copy of a picker's entries in display-name order; `dressOf` names each entry as a project. */
export function byDisplayName<T>(entries: readonly T[], dressOf: (entry: T) => Dressed): T[] {
  return [...entries].sort((left, right) => compareByDisplayName(dressOf(left), dressOf(right)))
}
