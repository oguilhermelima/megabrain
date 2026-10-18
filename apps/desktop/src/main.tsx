import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/App'
import { AppErrorBoundary } from '@/components/ErrorBoundary'
import { startAppSettings } from '@/lib/app-settings'
import { native } from '@/lib/surface'
import { preloadTerminalView } from '@/terminal/kept-terminals'
import { terminalEngine } from '@/terminal/terminal-engine'
import './styles.css'

if (native) document.documentElement.classList.add('native')

const root = document.getElementById('root')
if (root === null) throw new Error('missing #root')
createRoot(root).render(<StrictMode><AppErrorBoundary><App /></AppErrorBoundary></StrictMode>)

startAppSettings()

// The first switch to a terminal should not wait for xterm's code or the engine setting: both load
// once the app has painted.
setTimeout(() => {
  preloadTerminalView()
  void terminalEngine()
}, 1500)
