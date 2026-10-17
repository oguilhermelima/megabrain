type BridgeMessage = { onmessage: ((message: any) => void) | null }

const bridgeAddress = import.meta.env.VITE_MEGABRAIN_BRIDGE
const bridgeToken = import.meta.env.VITE_MEGABRAIN_BRIDGE_TOKEN
if (!bridgeAddress || !bridgeToken) throw new Error('The web bridge is not configured.')
const address: string = bridgeAddress
const token: string = bridgeToken

export async function invoke<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (command === 'cli_stream') {
    const response = await fetch(`${address}/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-megabrain-token': token },
      body: JSON.stringify({ command, ...args }),
    })
    const result = await response.json() as { streamId?: string; error?: string }
    if (!response.ok || !result.streamId) throw new Error(result.error ?? `Bridge request failed (${response.status})`)
    const channel = args.onLine as BridgeMessage | undefined
    const source = new EventSource(`${address}/events/${result.streamId}?token=${encodeURIComponent(token)}`)
    source.onmessage = (message) => { try { channel?.onmessage?.(JSON.parse(message.data)) } catch (error) { console.error(error) } }
    source.addEventListener('done', () => source.close())
    return result.streamId as T
  }
  if (command === 'cli_stream_stop') {
    await fetch(`${address}/stream/${String(args.streamId)}/stop`, { method: 'POST', headers: { 'x-megabrain-token': token } })
    return undefined as T
  }
  const response = await fetch(`${address}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-megabrain-token': token },
    body: JSON.stringify({ command, ...args }),
  })
  const result = await response.json() as { error?: string } & T
  if (!response.ok) throw new Error(result.error ?? `Bridge request failed (${response.status})`)
  return result as T
}

export class Channel<T = unknown> {
  onmessage: ((message: T) => void) | null = null
}

export async function listen<T>(event: string, handler: (message: { event: string; id: number; payload: T }) => void) {
  const source = new EventSource(`${address}/events?token=${encodeURIComponent(token)}`)
  source.addEventListener(event, (message) => {
    try { handler({ event, id: Number(message.lastEventId || 0), payload: JSON.parse(message.data) }) }
    catch (error) { console.error(error) }
  })
  return () => source.close()
}

export function getCurrentWindow() {
  return {
    label: 'main',
    isVisible: async () => true,
    show: async () => undefined,
    hide: async () => undefined,
    unminimize: async () => undefined,
    setFocus: async () => window.focus(),
    onFocusChanged: async (callback: (event: { payload: boolean }) => void) => {
      const listener = () => callback({ payload: document.hasFocus() })
      window.addEventListener('focus', listener); window.addEventListener('blur', listener)
      return () => { window.removeEventListener('focus', listener); window.removeEventListener('blur', listener) }
    },
    onResized: async (callback: () => void) => { window.addEventListener('resize', callback); return () => window.removeEventListener('resize', callback) },
    onMoved: async () => () => undefined,
    listen: async <T,>(event: string, callback: (event: { payload: T }) => void) => listen(event, callback as any),
  }
}
export function getCurrentWebview() {
  return { onDragDropEvent: async () => () => undefined }
}
export async function homeDir() { return '/' }
export function convertFileSrc(path: string) { return path.startsWith('file://') ? path : `file://${path}` }
export async function readText() { return await navigator.clipboard.readText() }
export async function writeText(text: string) { await navigator.clipboard.writeText(text) }
export async function readImage() { throw new Error('Clipboard images need the desktop app.') }
export async function writeImage() { throw new Error('Clipboard images need the desktop app.') }
export async function open() { throw new Error('Choosing local files or folders needs the desktop app.') }
export async function save() { throw new Error('Saving to a chosen path needs the desktop app.') }
export async function openUrl(url: string) { window.open(url, '_blank', 'noopener,noreferrer') }
export async function revealItemInDir() { throw new Error('File reveal needs the desktop app.') }
