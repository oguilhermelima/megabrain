import { describe, expect, test } from 'bun:test'
import { base64ToBytes } from '@/terminal/terminal-model'

describe('base64ToBytes', () => {
  test('decodes ASCII', () => {
    expect(Array.from(base64ToBytes(btoa('$ ls\r\n')))).toEqual([36, 32, 108, 115, 13, 10])
  })

  test('keeps multi-byte UTF-8 as raw bytes for the terminal to decode', () => {
    // "é" is 0xC3 0xA9 in UTF-8; "→" is 0xE2 0x86 0x92.
    expect(Array.from(base64ToBytes('w6nihpI='))).toEqual([0xc3, 0xa9, 0xe2, 0x86, 0x92])
  })

  test('keeps bytes that are not valid UTF-8 on their own, such as a sequence split across chunks', () => {
    expect(Array.from(base64ToBytes('4oY='))).toEqual([0xe2, 0x86])
  })

  test('an empty chunk is no bytes', () => {
    expect(base64ToBytes('').length).toBe(0)
  })
})
