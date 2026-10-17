import { useEffect, useMemo, useRef, useState } from 'react'
import { artifactFrameDocument } from '@/advanced/artifacts-model'

// An HTML artifact in a sandboxed frame: an empty sandbox runs no script and, without same-origin,
// cannot reach the app; its document's policy (artifacts-model.ts) blocks every fetch. A new version
// loads in a second frame behind the shown one and takes its place once it has loaded, so a live
// update replaces the page without a blank frame in between. The frames scroll on their own.

type Layer = { key: number; doc: string }

/** The artifact's HTML filling `className`'s box; the box gives the border, radius and background. */
export function ArtifactFrame({ title, html, className = '' }: { title: string; html: string; className?: string }) {
  const doc = useMemo(() => artifactFrameDocument(html), [html])
  const next = useRef(1)
  // The first layer is shown; a later one is loading behind it.
  const [layers, setLayers] = useState<Layer[]>(() => [{ key: 0, doc }])
  useEffect(() => {
    setLayers((current) => {
      if (current.at(-1)?.doc === doc) return current
      const layer = { key: next.current++, doc }
      // A version that arrives while another loads replaces the one loading.
      const shown = current[0]
      return shown === undefined ? [layer] : [shown, layer]
    })
  }, [doc])
  const loaded = (key: number) => setLayers((current) => {
    const index = current.findIndex((layer) => layer.key === key)
    return index <= 0 ? current : current.slice(index)
  })
  return (
    <div className={`relative overflow-hidden ${className}`}>
      {layers.map((layer, index) => (
        <iframe
          key={layer.key}
          title={title}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={layer.doc}
          onLoad={() => loaded(layer.key)}
          aria-hidden={index > 0 ? true : undefined}
          tabIndex={index > 0 ? -1 : undefined}
          className={`absolute inset-0 block h-full w-full ${index > 0 ? 'pointer-events-none opacity-0' : ''}`}
        />
      ))}
    </div>
  )
}
