import { describe, expect, test } from 'bun:test'
import { headerText } from '@/chat/header-model'

describe('headerText', () => {
  test('shows the title and the branch', () => {
    expect(headerText({ title: 'Fix login', branch: 'fix/login', slim: false })).toEqual({ title: 'Fix login', branch: 'fix/login' })
  })

  test('a blank title reads New chat', () => {
    expect(headerText({ title: '  ', branch: 'main', slim: false }).title).toBe('New chat')
  })

  test('no branch, or a blank one, leaves the title alone', () => {
    expect(headerText({ title: 'Fix login', branch: null, slim: false }).branch).toBeNull()
    expect(headerText({ title: 'Fix login', branch: ' ', slim: false }).branch).toBeNull()
  })

  test('a slim header under the shared bar shows the title only', () => {
    expect(headerText({ title: 'Fix login', branch: 'fix/login', slim: true })).toEqual({ title: 'Fix login', branch: null })
  })
})
