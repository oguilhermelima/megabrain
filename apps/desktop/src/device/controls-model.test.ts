import { describe, expect, test } from 'bun:test'
import { controlsFor, nextOrientation, webRotation } from '@/device/controls-model'

const names = (group: Parameters<typeof controlsFor>[0]) => controlsFor(group).buttons.map((control) => control.name)

describe('controls per device kind', () => {
  test('an Apple TV gets the remote: the pad, then menu, play/pause and home', () => {
    expect(controlsFor('tv').pad).toBe(true)
    expect(names('tv')).toEqual(['menu', 'play-pause', 'home'])
    expect(controlsFor('tv').address).toBe(false)
  })

  test('a phone and a tablet get the same hardware, rotate, screenshot and keyboard', () => {
    const handheld = ['home', 'lock', 'volume-down', 'volume-up', 'rotate', 'screenshot', 'keyboard']
    expect(names('phone')).toEqual(handheld)
    expect(names('tablet')).toEqual(handheld)
    expect(controlsFor('phone').pad).toBe(false)
    expect(controlsFor('phone').address).toBe(false)
  })

  test('a browser gets back, forward, reload, rotate and its address and viewport', () => {
    expect(names('web')).toEqual(['back', 'forward', 'reload', 'rotate'])
    expect(controlsFor('web').address).toBe(true)
    expect(controlsFor('web').pad).toBe(false)
  })

  test('every control has a label for its button', () => {
    for (const group of ['phone', 'tablet', 'tv', 'web'] as const) for (const control of controlsFor(group).buttons) expect(control.label.length).toBeGreaterThan(0)
  })
})

describe('rotate', () => {
  test('a simulator turns to landscape first, then back', () => {
    expect(nextOrientation(undefined)).toBe('landscape')
    expect(nextOrientation('landscape')).toBe('portrait')
    expect(nextOrientation('portrait')).toBe('landscape')
  })

  test('a browser turns its preset the other way from its CSS size, and needs a preset', () => {
    expect(webRotation('iphone17', { width: 402, height: 874 })).toEqual({ preset: 'iphone17', landscape: true })
    expect(webRotation('iphone17', { width: 874, height: 402 })).toEqual({ preset: 'iphone17', landscape: false })
    expect(webRotation(null, { width: 402, height: 874 })).toBeNull()
  })
})
