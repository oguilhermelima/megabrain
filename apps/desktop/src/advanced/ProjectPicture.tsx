import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { Project } from '@/api/schema'
import { customPicture, displayName, pictureUrl } from '@/advanced/appearance-model'
import { githubAvatarUrl, pictureCandidates, pictureSource, projectColor, projectInitials, svgDataUrl } from '@/advanced/picture-model'
import { native } from '@/lib/surface'

const toAsset = native ? convertFileSrc : null

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

const boxes = {
  row: 'size-6 shrink-0 rounded-[8px] text-[10.5px]',
  large: 'size-10 shrink-0 rounded-[12px] text-[15px]',
  hero: 'size-16 shrink-0 rounded-[20px] text-[22px]',
}

/**
 * The picture the person chose in Settings, else the detected one (picture-model.ts), else the
 * initials of the display name. 24px in a sidebar row, large is 40px, and hero (64px) heads a project's page.
 */
export function ProjectPicture({ project, size = 'row' }: { project: Project; size?: 'row' | 'large' | 'hero' }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const chosen = customPicture(project)
  const chosenUrl = chosen === null ? null : pictureUrl(chosen, toAsset)
  const [chosenFailed, setChosenFailed] = useState(false)

  useEffect(() => setChosenFailed(false), [chosenUrl])

  useEffect(() => {
    // A row that now shows another project must not keep the last one's picture.
    setUrl(null)
    setFailed(false)
    if (project.missing) return
    let stopped = false
    void resolvePicture(project).then((value) => !stopped && setUrl(value))
    return () => {
      stopped = true
    }
    // The cache is keyed by path; the remote does not change under a registered project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path, project.missing])

  const box = boxes[size]
  if (chosenUrl !== null && !chosenFailed) {
    return <img src={chosenUrl} alt="" draggable={false} onError={() => setChosenFailed(true)} className={`${box} bg-white/[0.06] object-cover`} />
  }
  if (url !== null && !failed) {
    return <img src={url} alt="" draggable={false} onError={() => setFailed(true)} className={`${box} bg-white/[0.06] object-contain`} />
  }
  return (
    <span aria-hidden="true" style={{ backgroundColor: projectColor(project.name) }} className={`${box} grid place-items-center font-bold tracking-[0.02em] text-white ${project.missing ? 'opacity-40' : ''}`}>
      {projectInitials(displayName(project))}
    </span>
  )
}
