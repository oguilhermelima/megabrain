import { describe, expect, test } from 'bun:test'
import { createElement, isValidElement } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { caughtError, errorDetails, type CaughtError } from '@/components/error-report'

const at = new Date('2026-10-18T20:30:00.000Z')

describe('a caught error', () => {
  test('keeps the error, where it happened and the component stack', () => {
    const error = new ReferenceError("Cannot access 'rootOf' before initialization")
    const caught = caughtError('pane', 'launcher:1', error, '\n    in Launcher\n    in PaneArea\n', at)
    expect(caught).toEqual({
      at: '2026-10-18T20:30:00.000Z',
      where: 'pane',
      item: 'launcher:1',
      name: 'ReferenceError',
      message: "Cannot access 'rootOf' before initialization",
      stack: error.stack ?? null,
      componentStack: 'in Launcher\n    in PaneArea',
    })
  })

  test('anything thrown that is not an Error still reads', () => {
    expect(caughtError('app', null, 'plain text', null, at)).toMatchObject({ name: 'string', message: 'plain text', stack: null, componentStack: null })
    expect(caughtError('app', null, undefined, '  ', at)).toMatchObject({ name: 'undefined', message: 'undefined', componentStack: null })
  })

  test('its details name the error, the place, the stack and the components', () => {
    const error = new TypeError('boom')
    error.stack = 'TypeError: boom\n    at Launcher'
    const details = errorDetails(caughtError('pane', 'native:7', error, 'in Launcher', at))
    expect(details).toBe('TypeError: boom\nAt 2026-10-18T20:30:00.000Z, in the pane showing native:7.\n\nStack:\nTypeError: boom\n    at Launcher\n\nComponents:\nin Launcher')
    expect(errorDetails(caughtError('app', null, 'x', null, at))).toBe('string: x\nAt 2026-10-18T20:30:00.000Z, in the app.')
  })
})

describe('the error boundary', () => {
  const fallback = (caught: CaughtError, retry: () => void) => createElement('p', { onClick: retry }, `${caught.where} ${caught.item ?? '-'} ${caught.message}`)

  test('renders its children until something below it throws, then the fallback, until retried', () => {
    const boundary = new ErrorBoundary({ where: 'pane', item: 'launcher:1', fallback, children: 'the pane' })
    expect(boundary.render()).toBe('the pane')
    boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(new Error('broke')) }
    const shown = boundary.render()
    expect(isValidElement(shown) ? (shown.props as { children: string }).children : null).toBe('pane launcher:1 broke')
    let state = boundary.state
    boundary.setState = (next) => { state = { ...state, ...(next as typeof state) } }
    boundary.retry()
    boundary.state = state
    expect(boundary.render()).toBe('the pane')
  })
})
