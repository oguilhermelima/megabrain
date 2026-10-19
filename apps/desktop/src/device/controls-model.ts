import type { DeviceGroup } from '@/device/device-model'
import type { Orientation } from '@/api/schema'

// The controls at the bottom of the Devices panel, for the selected device: an Apple TV's remote, a
// phone's or tablet's hardware, or a browser's navigation, address and viewport. A control's name is
// the button `native input button` takes, or one of the actions the view runs itself (rotate,
// screenshot, keyboard, back, forward, reload).

export interface Control {
  name: string
  label: string
}

export interface DeviceControls {
  /** The remote's direction pad and Select. */
  pad: boolean
  buttons: Control[]
  /** The browser's URL field and viewport preset. */
  address: boolean
}

const handheld: Control[] = [
  { name: 'home', label: 'Home' },
  { name: 'lock', label: 'Lock' },
  { name: 'volume-down', label: 'Volume down' },
  { name: 'volume-up', label: 'Volume up' },
  { name: 'rotate', label: 'Rotate' },
  { name: 'screenshot', label: 'Screenshot' },
  { name: 'keyboard', label: 'Type from the keyboard' },
]

const controls: Record<DeviceGroup, DeviceControls> = {
  phone: { pad: false, buttons: handheld, address: false },
  tablet: { pad: false, buttons: handheld, address: false },
  tv: {
    pad: true,
    buttons: [
      { name: 'menu', label: 'Menu' },
      { name: 'play-pause', label: 'Play/Pause' },
      { name: 'home', label: 'Home' },
    ],
    address: false,
  },
  web: {
    pad: false,
    buttons: [
      { name: 'back', label: 'Back' },
      { name: 'forward', label: 'Forward' },
      { name: 'reload', label: 'Reload' },
      { name: 'rotate', label: 'Rotate' },
    ],
    address: true,
  },
}

export const controlsFor = (group: DeviceGroup): DeviceControls => controls[group]

/** What a simulator's rotate asks for: the other orientation from the one it shows (portrait until known). */
export const nextOrientation = (current: Orientation | undefined): Orientation => (current === 'landscape' ? 'portrait' : 'landscape')

/**
 * What a browser's rotate asks `web device input viewport` for: its preset turned the other way from
 * the CSS size it has now. Null without a preset, which the viewport needs.
 */
export function webRotation(preset: string | null, size: { width: number; height: number }): { preset: string; landscape: boolean } | null {
  return preset === null ? null : { preset, landscape: size.width <= size.height }
}
