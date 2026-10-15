import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { Project } from '@/api/schema'
import { githubAvatarUrl, pictureCandidates, pictureSource, projectColor, projectInitials, svgDataUrl } from '@/advanced/picture-model'

// One lookup per project per session: listing a repository's files is a git call, and the picture
// does not change while the app is open.
const cache = new Map<string, Promise<string | null>>()

async function repositoryImage(root: string): Promise<string | null> {
  const entries = await api.codeTree(root)
  const paths = entries.filter((entry) => entry.kind === 'file').map((entry) => entry.path)
  if (pictureSource(paths, null).kind !== 'file') return null
  for (const path of pictureCandidates(paths).slice(0, 3)) {
    const file = await api.codeRead(root, path)
    const url = file.text === null ? null : svgDataUrl(file.text)
    if (url !== null) return url
  }
  return null
}

function resolvePicture(project: Project): Promise<string | null> {
  const known = cache.get(project.path)
  if (known !== undefined) return known
  const pending = repositoryImage(project.path)
    .catch(() => null)
    .then((url) => url ?? githubAvatarUrl(project.remote))
  cache.set(project.path, pending)
  return pending
}

export function ProjectPicture({ project }: { project: Project }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (project.missing) return
    let stopped = false
    void resolvePicture(project).then((value) => !stopped && setUrl(value))
    return () => {
      stopped = true
    }
    // The cache is keyed by path; the remote does not change under a registered project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path, project.missing])

  const box = 'size-6 shrink-0 rounded-[8px]'
  if (url !== null && !failed) {
    return <img src={url} alt="" draggable={false} onError={() => setFailed(true)} className={`${box} bg-white/[0.06] object-contain`} />
  }
  return (
    <span aria-hidden="true" style={{ backgroundColor: projectColor(project.name) }} className={`${box} grid place-items-center text-[10.5px] font-bold tracking-[0.02em] text-white ${project.missing ? 'opacity-40' : ''}`}>
      {projectInitials(project.name)}
    </span>
  )
}
