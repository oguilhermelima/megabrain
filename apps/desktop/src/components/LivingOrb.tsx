import { useEffect, useRef, useState } from 'react'

// megabrain's orb as something alive: soft blobs of the brand colours drift and change shape inside
// the circle while a glow breathes around it, like a thought turning over. All of it is CSS keyframes
// on transform and opacity (styles.css, .living-orb), so the compositor runs it with no script or
// layout per frame. It stops while the window is hidden or the orb is scrolled out of view, and
// reduced motion leaves a still, softly lit orb.

/** The animated orb, size px across. */
export function LivingOrb({ size = 112 }: { size?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(true)
  const [shown, setShown] = useState(() => document.visibilityState !== 'hidden')

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? true))
    observer.observe(element)
    const onVisibility = () => setShown(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <div ref={ref} aria-hidden="true" className="living-orb" data-paused={visible && shown ? undefined : ''} style={{ width: size, height: size }}>
      <div className="living-orb-glow" />
      <div className="living-orb-body">
        <div className="living-orb-base" />
        <div className="living-orb-blob living-orb-blob-1" />
        <div className="living-orb-blob living-orb-blob-2" />
        <div className="living-orb-blob living-orb-blob-3" />
        <div className="living-orb-blob living-orb-blob-4" />
        <div className="living-orb-sheen" />
      </div>
    </div>
  )
}
