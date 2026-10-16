import { describe, expect, test } from 'bun:test'
import { headerTitle } from '@/chat/header-model'

describe('headerTitle', () => {
  test('shows the title as given', () => {
    expect(headerTitle('Fix login')).toBe('Fix login')
  })

  test('a blank title reads New chat', () => {
    expect(headerTitle('  ')).toBe('New chat')
    expect(headerTitle('')).toBe('New chat')
  })
})
