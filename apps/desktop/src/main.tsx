import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/App'
import { native, surface } from '@/lib/surface'
import { Pill } from '@/pill/Pill'
import { preloadTerminalView } from '@/terminal/kept-terminals'
import { terminalEngine } from '@/terminal/terminal-engine'
import './styles.css'

if (native) document.documentElement.classList.add('native')

const root = document.getElementById('root')
if (root === null) throw new Error('missing #root')
createRoot(root).render(<StrictMode>{surface() === 'pill' ? <Pill /> : <App />}</StrictMode>)

// The first switch to a terminal should not wait for xterm's code or the engine setting: both load
// once the app has painted.
if (surface() !== 'pill')
  setTimeout(() => {
    preloadTerminalView()
    void terminalEngine()
  }, 1500)
