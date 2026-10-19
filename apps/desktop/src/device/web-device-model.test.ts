import { describe, expect, test } from 'bun:test'
import type { ProjectScripts } from '@/api/schema'
import { devServerUrl, presetGroups, viewportLabel, webDeviceName, webUrl } from '@/device/web-device-model'
import { viewportPresetListSchema, webDeviceListSchema, webDeviceSchema, webInputArgs, webInputSchema, webStartArgs, webViewportSchema, type ViewportPreset } from '@/device/web-device-standin'

const scripts = (run: string | null, port: number | null): ProjectScripts => ({
  repo: '/repo',
  scripts: { run: run === null ? null : { command: run, source: 'saved' }, build: null, install: null },
  port: port === null ? null : { port, framework: 'vite', source: 'command', detail: '', fragment: null, override: null },
})

describe('web device start form', () => {
  test('the dev server URL is prefilled only when the project has a Run script with a port', () => {
    expect(devServerUrl(scripts('bun dev', 5173))).toBe('http://localhost:5173')
    expect(devServerUrl(scripts('bun dev', null))).toBe('')
    expect(devServerUrl(scripts(null, 5173))).toBe('')
    expect(devServerUrl(null)).toBe('')
  })

  test('a URL is http or https; a bare host or host:port gets http', () => {
    expect(webUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(webUrl('  localhost:3000 ')).toBe('http://localhost:3000/')
    expect(webUrl('localhost:3000/settings')).toBe('http://localhost:3000/settings')
    expect(webUrl('example.com')).toBe('http://example.com/')
    expect(webUrl('')).toBeNull()
    expect(webUrl('javascript:alert(1)')).toBeNull()
    expect(webUrl('file:///etc/passwd')).toBeNull()
    expect(webUrl('http://')).toBeNull()
  })

  test('presets group by category in the order the list first names them', () => {
    const preset = (slug: string, category: string): ViewportPreset => ({ slug, label: slug, category, origin: 'owned', width: 1, height: 1 })
    const grouped = presetGroups([preset('iphone17', 'mobile'), preset('macbookpro14', 'laptop'), preset('pixel9', 'mobile')])
    expect(grouped.map((group) => [group.category, group.presets.map((entry) => entry.slug)])).toEqual([
      ['mobile', ['iphone17', 'pixel9']],
      ['laptop', ['macbookpro14']],
    ])
  })
})

describe('web device rows', () => {
  test('a row names the page title, else the host and path', () => {
    expect(webDeviceName({ title: ' Canto ', url: 'http://localhost:3000/' })).toBe('Canto')
    expect(webDeviceName({ title: '', url: 'http://localhost:3000/' })).toBe('localhost:3000')
    expect(webDeviceName({ title: '', url: 'http://localhost:3000/settings' })).toBe('localhost:3000/settings')
    expect(webDeviceName({ title: '', url: 'not a url' })).toBe('not a url')
  })

  test('the trailing text is the CSS size', () => {
    expect(viewportLabel({ width: 402, height: 681.4 })).toBe('402×681')
  })
})

describe('web device stand-in', () => {
  const device = { id: 'web-1f2e', kind: 'web' as const, url: 'http://localhost:3000/', title: 'Canto', width: 402, height: 874, scale: 3, streamUrl: 'http://127.0.0.1:52011/' }

  test('start and list answer the contract shape', () => {
    expect(webDeviceSchema.parse(device)).toEqual(device)
    expect(webDeviceListSchema.parse({ devices: [device] }).devices).toHaveLength(1)
    expect(webDeviceSchema.safeParse({ ...device, kind: 'phone' }).success).toBe(false)
    expect(webDeviceSchema.safeParse({ ...device, streamUrl: undefined }).success).toBe(false)
  })

  test('input, viewport and preset answers parse', () => {
    expect(webInputSchema.parse({ ok: true, ms: 12 })).toEqual({ ok: true, ms: 12 })
    expect(webViewportSchema.parse({ ok: true, width: 874, height: 402 })).toEqual({ ok: true, width: 874, height: 402 })
    const presets = viewportPresetListSchema.parse({ devices: [{ slug: 'fullhd', label: 'Full HD desktop', category: 'desktop', origin: 'owned', width: 1920, height: 1080, scale: 1, mobile: false }, { slug: 'x', label: 'X', category: 'mobile', origin: 'registry', width: null, height: null }] })
    expect(presets.devices.map((entry) => entry.slug)).toEqual(['fullhd', 'x'])
  })

  test('start passes the preset and worktree only when given', () => {
    expect(webStartArgs('http://localhost:3000/', 'iphone17', '/wt')).toEqual(['web', 'device', 'start', '--url', 'http://localhost:3000/', '--device', 'iphone17', '--worktree', '/wt', '--json'])
    expect(webStartArgs('http://a/', null, null)).toEqual(['web', 'device', 'start', '--url', 'http://a/', '--json'])
  })

  test('each action becomes the verb and arguments after input <id>', () => {
    expect(webInputArgs({ type: 'tap', x: 10, y: 20 })).toEqual(['tap', '10', '20'])
    expect(webInputArgs({ type: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4, ms: 300 })).toEqual(['swipe', '1', '2', '3', '4', '--ms', '300'])
    expect(webInputArgs({ type: 'swipe', x1: 1, y1: 2, x2: 3, y2: 4 })).toEqual(['swipe', '1', '2', '3', '4'])
    expect(webInputArgs({ type: 'scroll', x: 5, y: 6, dx: 0, dy: -120 })).toEqual(['scroll', '5', '6', '0', '-120'])
    expect(webInputArgs({ type: 'type', text: 'hi there' })).toEqual(['type', 'hi there'])
    expect(webInputArgs({ type: 'key', name: 'return' })).toEqual(['key', 'return'])
    expect(webInputArgs({ type: 'navigate', url: 'http://a/' })).toEqual(['navigate', 'http://a/'])
    expect(webInputArgs({ type: 'back' })).toEqual(['back'])
    expect(webInputArgs({ type: 'forward' })).toEqual(['forward'])
    expect(webInputArgs({ type: 'reload' })).toEqual(['reload'])
    expect(webInputArgs({ type: 'viewport', preset: 'iphone17', landscape: true })).toEqual(['viewport', 'iphone17', '--landscape'])
    expect(webInputArgs({ type: 'viewport', preset: 'iphone17', landscape: false })).toEqual(['viewport', 'iphone17'])
  })
})
