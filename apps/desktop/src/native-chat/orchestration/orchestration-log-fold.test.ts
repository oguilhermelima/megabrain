import { describe, expect, test } from 'bun:test'
import { logFoldKey, readLogFolded, writeLogFolded } from '@/native-chat/orchestration/orchestration-log-fold'

const memory = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial))
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values }
}
const broken = { getItem: (): string | null => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }

describe('log fold', () => {
  test('folded when nothing was kept', () => {
    expect(readLogFolded(memory())).toBe(true)
  })
  test('open once the viewer opened it, folded again once they fold it', () => {
    const storage = memory()
    writeLogFolded(storage, false)
    expect(storage.values.get(logFoldKey)).toBe('false')
    expect(readLogFolded(storage)).toBe(false)
    writeLogFolded(storage, true)
    expect(readLogFolded(storage)).toBe(true)
  })
  test('a value it does not know reads as folded', () => {
    expect(readLogFolded(memory({ [logFoldKey]: 'maybe' }))).toBe(true)
  })
  test('storage that throws reads folded and a write does not throw', () => {
    expect(readLogFolded(broken)).toBe(true)
    expect(() => writeLogFolded(broken, false)).not.toThrow()
  })
})
