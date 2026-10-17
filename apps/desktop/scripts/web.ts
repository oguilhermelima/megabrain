import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { startWebBridge } from './web-bridge'

const app = dirname(dirname(fileURLToPath(import.meta.url)))
const triple = process.platform === 'darwin'
  ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
  : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`
const cliPath = process.env.MEGABRAIN_CLI_PATH ?? join(app, 'src-tauri', 'binaries', `megabrain-cli-${triple}`)
const cliRoot = join(app, 'src-tauri', 'binaries', 'share', 'megabrain')
const bridge = await startWebBridge({ cliPath, cliRoot, path: process.env.PATH, stateDir: process.env.MEGABRAIN_STATE_DIR, webOrigin: 'http://127.0.0.1:1420' })
process.env.VITE_MEGABRAIN_BRIDGE = bridge.url
process.env.VITE_MEGABRAIN_BRIDGE_TOKEN = bridge.token

let vite: Awaited<ReturnType<typeof createServer>> | undefined
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await vite?.close()
  await bridge.stop()
}
process.once('SIGINT', () => { void stop().finally(() => process.exit(0)) })
process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)) })

try {
  vite = await createServer({ configFile: join(app, 'vite.config.ts'), root: app })
  await vite.listen()
  vite.printUrls()
  console.log(`Authenticated local bridge: ${bridge.url}`)
} catch (error) {
  await stop()
  throw error
}
