import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@/App'
import { native, surface } from '@/lib/surface'
import { Pill } from '@/pill/Pill'
import './styles.css'

if (native) document.documentElement.classList.add('native')

const root = document.getElementById('root')
if (root === null) throw new Error('missing #root')
createRoot(root).render(<StrictMode>{surface() === 'pill' ? <Pill /> : <App />}</StrictMode>)
