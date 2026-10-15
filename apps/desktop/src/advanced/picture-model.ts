// Which picture a project row shows: an icon or logo the repository itself carries, else its GitHub
// owner's avatar, else a coloured square with its initials. The app reads repository files as text
// only, so a repository image has to be an SVG; raster icons (favicon.ico, apple-touch-icon.png) are
// out of reach without a native byte reader.

export type PictureSource = { kind: 'file'; path: string } | { kind: 'avatar'; url: string } | { kind: 'initials' }

const skippedFolders = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'coverage', 'target', 'pods', '.next', '.git', 'tmp'])

/** favicon, icon, app-icon, apple-touch-icon and logo, optionally with a suffix such as logo-dark. */
const pictureName = /^(favicon|apple-touch-icon|app[-_]?icon|icon|logo)([-_.@].*)?$/

/** SVG icons and logos in a repository's file list, icons before logos and shallow before deep. */
export function pictureCandidates(paths: string[]): string[] {
  const ranked: { path: string; kind: number; depth: number }[] = []
  for (const path of paths) {
    const parts = path.split('/')
    const file = (parts.at(-1) ?? '').toLowerCase()
    if (!file.endsWith('.svg')) continue
    if (parts.slice(0, -1).some((part) => skippedFolders.has(part.toLowerCase()))) continue
    const match = pictureName.exec(file.slice(0, -'.svg'.length))
    if (match === null) continue
    ranked.push({ path, kind: match[1] === 'logo' ? 1 : 0, depth: parts.length })
  }
  ranked.sort((left, right) => left.kind - right.kind || left.depth - right.depth || left.path.localeCompare(right.path))
  return ranked.map((entry) => entry.path)
}

/** The GitHub owner of an https, ssh or scp-style github.com remote; null for any other host. */
export function githubOwner(remote: string | null): string | null {
  if (remote === null) return null
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\//.exec(remote.trim())
  return match?.[1] ?? null
}

export function githubAvatarUrl(remote: string | null): string | null {
  const owner = githubOwner(remote)
  return owner === null ? null : `https://github.com/${owner}.png?size=64`
}

/** The first choice for a project; the row falls through to the next source if loading it fails. */
export function pictureSource(paths: string[], remote: string | null): PictureSource {
  const path = pictureCandidates(paths)[0]
  if (path !== undefined) return { kind: 'file', path }
  const url = githubAvatarUrl(remote)
  if (url !== null) return { kind: 'avatar', url }
  return { kind: 'initials' }
}

/** Two letters for a two-word name (canto-space, juntinApp), one for a single word. */
export function projectInitials(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
  const letters = words
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase()
  return letters === '' ? '?' : letters
}

// Mid-tone colours that keep white initials above 4.5:1.
const palette = ['#4f46e5', '#7c3aed', '#be185d', '#b91c1c', '#c2410c', '#a16207', '#4d7c0f', '#047857', '#0e7490', '#1d4ed8']

/** A colour picked by the name, so a project keeps its colour across launches. */
export function projectColor(name: string): string {
  let hash = 2166136261
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return palette[hash % palette.length] ?? '#4f46e5'
}

const maxSvgLength = 200_000

/** An <img>-ready data URL for SVG text; null when the text is not an SVG or is too large. */
export function svgDataUrl(text: string): string | null {
  if (text.length > maxSvgLength || !/<svg[\s>]/i.test(text)) return null
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`
}
