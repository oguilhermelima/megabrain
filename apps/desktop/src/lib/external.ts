// What the app hands to the system: only https addresses open in the browser, and only folders
// inside a listed project or worktree show in Finder.

/** The address when it is a well-formed https URL, else null. */
export function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** Whether `path` is one of `roots` or inside one, compared by whole path segments. */
export function insideRoots(path: string, roots: readonly string[]): boolean {
  if (!path.startsWith('/') || path.split('/').includes('..')) return false
  const trimmed = path.replace(/\/+$/, '')
  return roots.some((root) => {
    const base = root.replace(/\/+$/, '')
    return base !== '' && (trimmed === base || trimmed.startsWith(`${base}/`))
  })
}
