import { lazy, Suspense } from 'react'

const SettingsWindow = lazy(() => import('@/settings/SettingsWindow').then((module) => ({ default: module.SettingsWindow })))

/** Settings keeps its own lazy boundary and resets its initial page when its target changes. */
export function SettingsOverlay({ open, project, section, chat, onClose, onSetup }: {
  open: boolean
  project: string | null
  section: 'knowledge' | null
  chat: { id: string; title: string } | null
  onClose: () => void
  onSetup: () => void
}) {
  if (!open) return null
  return (
    <Suspense fallback={null}>
      <SettingsWindow key={`${project ?? ''}\n${section ?? ''}`} focusProject={project} initialSection={section} focusChat={chat} onClose={onClose} onSetup={onSetup} />
    </Suspense>
  )
}
