import { describe, expect, test } from 'bun:test'
import { composerBanner, promptKey, ringOffset, sendState, trapFocus } from '@/chat/composer-look'

describe('sendState', () => {
  test('is ready only with something to send, nothing sending and the box enabled', () => {
    expect(sendState({ sendable: true, sending: false, disabled: false })).toBe('ready')
  })

  test('is empty with nothing to send, which paints the button grey', () => {
    expect(sendState({ sendable: false, sending: false, disabled: false })).toBe('empty')
  })

  test('is sending while a message goes, whatever the draft holds', () => {
    expect(sendState({ sendable: true, sending: true, disabled: false })).toBe('sending')
    expect(sendState({ sendable: false, sending: true, disabled: false })).toBe('sending')
  })

  test('is disabled when the box is, before anything else', () => {
    expect(sendState({ sendable: true, sending: true, disabled: true })).toBe('disabled')
    expect(sendState({ sendable: true, sending: false, disabled: true })).toBe('disabled')
  })

  test('is stop while the turn runs and the box holds nothing to send', () => {
    expect(sendState({ sendable: false, sending: false, disabled: false, running: true })).toBe('stop')
  })

  test('a draft typed while the turn runs can still be sent', () => {
    expect(sendState({ sendable: true, sending: false, disabled: false, running: true })).toBe('ready')
    expect(sendState({ sendable: false, sending: true, disabled: false, running: true })).toBe('sending')
    expect(sendState({ sendable: false, sending: false, disabled: true, running: true })).toBe('disabled')
  })
})

describe('composerBanner', () => {
  test('is nothing without a notice', () => {
    expect(composerBanner(null, { failedSend: true, sendable: true })).toBeNull()
  })

  test('an ok notice is a polite status with no action', () => {
    expect(composerBanner({ tone: 'ok', text: 'Delivered through socket.' }, { failedSend: false, sendable: true })).toEqual({
      tone: 'ok',
      role: 'status',
      text: 'Delivered through socket.',
      action: null,
    })
  })

  test('a failed send with the draft still there offers Retry as an alert', () => {
    expect(composerBanner({ tone: 'bad', text: 'Not delivered (tmux).' }, { failedSend: true, sendable: true })).toEqual({
      tone: 'bad',
      role: 'alert',
      text: 'Not delivered (tmux).',
      action: 'retry',
    })
  })

  test('an error that did not come from sending offers no Retry', () => {
    expect(composerBanner({ tone: 'bad', text: 'Dictation stopped: network.' }, { failedSend: false, sendable: true })?.action).toBeNull()
  })

  test('a failed send whose draft is gone has nothing to retry', () => {
    expect(composerBanner({ tone: 'bad', text: 'Not sent.' }, { failedSend: true, sendable: false })?.action).toBeNull()
  })

  test('an ok notice never offers Retry, even after a failure flag lingers', () => {
    expect(composerBanner({ tone: 'ok', text: 'Switched to Opus 5.5.' }, { failedSend: true, sendable: true })?.action).toBeNull()
  })
})

describe('ringOffset', () => {
  const circumference = 40

  test('an empty window shows a sliver, so the ring reads as a meter', () => {
    expect(ringOffset(0, circumference)).toBeCloseTo(40 * 0.98)
  })

  test('half used leaves half the stroke hidden', () => {
    expect(ringOffset(0.5, circumference)).toBeCloseTo(20)
  })

  test('a full or overfull window closes the ring', () => {
    expect(ringOffset(1, circumference)).toBe(0)
    expect(ringOffset(1.4, circumference)).toBe(0)
  })

  test('a negative share counts as empty', () => {
    expect(ringOffset(-0.2, circumference)).toBeCloseTo(40 * 0.98)
  })
})

describe('promptKey', () => {
  test('Escape cancels from anywhere in the card', () => {
    expect(promptKey({ key: 'Escape', onButton: false })).toBe('cancel')
    expect(promptKey({ key: 'Escape', onButton: true })).toBe('cancel')
  })

  test('Enter confirms, except on a button, which presses itself', () => {
    expect(promptKey({ key: 'Enter', onButton: false })).toBe('confirm')
    expect(promptKey({ key: 'Enter', onButton: true })).toBeNull()
  })

  test('Tab is kept inside the card', () => {
    expect(promptKey({ key: 'Tab', onButton: false })).toBe('trap')
  })

  test('other keys are left alone', () => {
    expect(promptKey({ key: ' ', onButton: false })).toBeNull()
    expect(promptKey({ key: 'a', onButton: true })).toBeNull()
  })
})

describe('trapFocus', () => {
  test('Tab moves forward and wraps to the first', () => {
    expect(trapFocus(0, 3, false)).toBe(1)
    expect(trapFocus(2, 3, false)).toBe(0)
  })

  test('Shift+Tab moves back and wraps to the last', () => {
    expect(trapFocus(1, 3, true)).toBe(0)
    expect(trapFocus(0, 3, true)).toBe(2)
  })

  test('focus outside the card enters at the first or, going back, the last', () => {
    expect(trapFocus(-1, 3, false)).toBe(0)
    expect(trapFocus(-1, 3, true)).toBe(2)
  })

  test('a card with nothing to focus has no target', () => {
    expect(trapFocus(0, 0, false)).toBeNull()
  })
})
