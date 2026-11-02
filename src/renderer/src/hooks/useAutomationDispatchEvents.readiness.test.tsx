// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./automation-dispatch-handler', () => ({
  handleAutomationDispatchRequest: vi.fn()
}))

import { useAutomationDispatchEvents } from './useAutomationDispatchEvents'

const rendererReady = vi.fn(async () => {})
const onDispatchRequested = vi.fn(() => () => {})

beforeEach(() => {
  rendererReady.mockClear()
  onDispatchRequested.mockClear()
  vi.stubGlobal('api', { automations: { rendererReady, onDispatchRequested } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Main dispatches every due run (including ones held while the window was closed) on rendererReady. */
describe('automation renderer readiness', () => {
  it('listens at mount but tells main it is ready only once the workspace session has hydrated', () => {
    const { rerender } = renderHook(({ ready }) => useAutomationDispatchEvents(ready), {
      initialProps: { ready: false }
    })

    expect(onDispatchRequested).toHaveBeenCalledOnce()
    expect(rendererReady).not.toHaveBeenCalled()

    rerender({ ready: true })
    rerender({ ready: true })

    expect(rendererReady).toHaveBeenCalledOnce()
    expect(onDispatchRequested).toHaveBeenCalledOnce()
  })
})
