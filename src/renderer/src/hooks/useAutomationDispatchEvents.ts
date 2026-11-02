import { useEffect } from 'react'
import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

export function useAutomationDispatchEvents(workspaceSessionReady: boolean): void {
  useEffect(() => {
    return window.api.automations.onDispatchRequested(handleAutomationDispatchRequest)
  }, [])

  useEffect(() => {
    // Main dispatches due runs on this signal; before repos hydrate they would read as removed (#12318).
    if (workspaceSessionReady) {
      void window.api.automations.rendererReady()
    }
  }, [workspaceSessionReady])
}
