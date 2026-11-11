import { describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from '../listener-state'
import { normalizeHookPayload } from '../normalization/normalize-hook-payload'
import { makePaneKey } from '../../workspace-layout/stable-pane-id'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const BUILD = { id: 'bbuild01', type: 'shell', status: 'running', command: 'pnpm build' }

function claudeEvent(state: HookListenerState, payload: Record<string, unknown>) {
  return normalizeHookPayload(state, 'claude', { paneKey: PANE, payload }, 'production')?.payload
}

const BASH_LAUNCH = {
  tool_name: 'Bash',
  tool_input: { command: BUILD.command, run_in_background: true },
  tool_response: { backgroundTaskId: BUILD.id }
}

describe('Claude finished held for background shells (opt-in)', () => {
  it('holds a user turn for its background shell and finishes once after the wake-up turn', () => {
    const state = createHookListenerState()
    state.claudeFinishedWaitsForBackgroundShells = () => true
    claudeEvent(state, { hook_event_name: 'UserPromptSubmit', prompt: 'build it' })
    claudeEvent(state, { hook_event_name: 'PostToolUse', ...BASH_LAUNCH })

    const stop = claudeEvent(state, { hook_event_name: 'Stop', background_tasks: [BUILD] })
    expect(stop).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    expect(stop?.turnCompletedAt).toBeUndefined()

    claudeEvent(state, {
      hook_event_name: 'UserPromptSubmit',
      prompt: `<task-notification><task-id>${BUILD.id}</task-id><status>completed</status></task-notification>`
    })
    const wakeEnd = claudeEvent(state, { hook_event_name: 'Stop', background_tasks: [] })
    expect(wakeEnd).toMatchObject({ state: 'done' })
  })
})
