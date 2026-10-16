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

/** An <img> source for a stored picture: a file path through the asset protocol, a data or https URL as it is. */
export function pictureUrl(picture: string, toAsset: ((path: string) => string) | null): string | null {
  if (/^(data:image\/|https:\/\/)/.test(picture)) return picture
  return toAsset === null ? null : toAsset(picture)
}

/** Alphabetical by display name, ignoring case; the path breaks a tie so the order never flickers. */
export function compareByDisplayName(left: Dressed, right: Dressed): number {
  return displayName(left).localeCompare(displayName(right), undefined, { sensitivity: 'base' }) || left.path.localeCompare(right.path)
}
