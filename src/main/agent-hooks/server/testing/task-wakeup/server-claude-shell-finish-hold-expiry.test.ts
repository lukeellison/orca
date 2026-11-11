// No hook fires when a held background shell outlives its window, so the server must announce the turn itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent, RUNNING_SHELL } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))
// The fixture's owner process is fictional; the pane's owning Claude is still running.
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn(async () => 'live')
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  // Real loopback POSTs need fake time to advance.
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Claude finished held for a background shell on the hook server', () => {
  let server: AgentHookServer
  const post = (payload: Record<string, unknown>) =>
    postHookEvent(server, buildBody({ session_id: 'session-1', ...payload }))
  const launchShell = (id: string) =>
    post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test', run_in_background: true },
      tool_response: { backgroundTaskId: id }
    })
  const row = () => server.getStatusSnapshotForPane(PANE)[0]

  beforeEach(async () => {
    server = new AgentHookServer()
    server.setClaudeFinishedWaitsForBackgroundShells(() => true)
    await server.start({ env: 'production' })
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'run the test suite' })
    await launchShell(RUNNING_SHELL.id)
    await post({ hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
  })

  afterEach(() => {
    server.stop()
  })

  it('announces the turn after 30 minutes while the shell is still running', async () => {
    expect(row()?.turnCompletedAt).toBeUndefined()

    vi.advanceTimersByTime(29 * 60_000)
    expect(row()?.turnCompletedAt).toBeUndefined()

    vi.advanceTimersByTime(60_000)
    expect(row()).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      turnCompletedAt: expect.any(Number)
    })
  })

  it('keeps the first deadline when a wake-up turn chains a new shell', async () => {
    const nextShell = { ...RUNNING_SHELL, id: 'shell-2' }
    vi.advanceTimersByTime(25 * 60_000)
    await post({
      hook_event_name: 'UserPromptSubmit',
      prompt: `<task-notification><task-id>${RUNNING_SHELL.id}</task-id><status>completed</status></task-notification>`
    })
    await launchShell(nextShell.id)
    await post({ hook_event_name: 'Stop', background_tasks: [nextShell] })
    expect(row()?.turnCompletedAt).toBeUndefined()

    vi.advanceTimersByTime(5 * 60_000)
    expect(row()?.turnCompletedAt).toEqual(expect.any(Number))
  })
})
