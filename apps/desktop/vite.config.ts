import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const bridge = fileURLToPath(new URL('./src/api/web-bridge.ts', import.meta.url))
const bridgeAliases = process.env.VITE_MEGABRAIN_BRIDGE
  ? [
      { find: '@tauri-apps/api/core', replacement: bridge },
      { find: '@tauri-apps/api/event', replacement: bridge },
      { find: '@tauri-apps/api/path', replacement: bridge },
      { find: '@tauri-apps/api/window', replacement: bridge },
      { find: '@tauri-apps/api/webview', replacement: bridge },
      { find: '@tauri-apps/plugin-clipboard-manager', replacement: bridge },
      { find: '@tauri-apps/plugin-dialog', replacement: bridge },
      { find: '@tauri-apps/plugin-opener', replacement: bridge },
    ]
  : []

// Tauri expects a fixed port on loopback.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: [{ find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) }, ...bridgeAliases] },
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'safari16', sourcemap: true },
})
