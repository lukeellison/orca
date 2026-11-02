import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type { Store } from '../persistence/loading-store/store'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { AutomationService } from './service'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const DUE = new Date('2026-05-13T09:00:00').getTime()

async function seedDailyAutomation(): Promise<{ store: Store; automationId: string }> {
  const store = await createStore()
  store.addRepo({ id: 'r1', path: '/repo', displayName: 'test', badgeColor: '#fff', addedAt: 1 })
  const automation = store.createAutomation({
    name: 'Nightly check',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime(),
    missedRunGraceMinutes: 60
  })
  return { store, automationId: automation.id }
}

function openWindow(service: AutomationService): ReturnType<typeof vi.fn> {
  const send = vi.fn()
  service.setWebContents({ isDestroyed: () => false, send })
  service.setRendererReady()
  return send
}

/** macOS keeps Orca running after its last window closes; the scheduler keeps ticking. */
describe('scheduled run that falls due while every window is closed', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-closed-window-deferral-test-'))
    vi.useFakeTimers()
    vi.setSystemTime(DUE - 30_000)
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    removeTreeSync(testState.dir)
  })

  it('records nothing while closed, then runs the occurrence when a window reopens in grace', async () => {
    const { store, automationId } = await seedDailyAutomation()
    const service = new AutomationService(store, { tickMs: 60_000 })
    openWindow(service)
    service.start()
    service.setWebContents(null)

    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(store.listAutomationRuns(automationId)).toEqual([])

    const send = openWindow(service)

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'automations:dispatchRequested',
        expect.objectContaining({ run: expect.objectContaining({ scheduledFor: DUE }) })
      )
    )
    expect(store.listAutomationRuns(automationId)).toMatchObject([
      { status: 'dispatching', scheduledFor: DUE }
    ])
    service.stop()
  })

  it('records the occurrence as missed when the window reopens past grace', async () => {
    const { store, automationId } = await seedDailyAutomation()
    const service = new AutomationService(store, { tickMs: 60_000 })
    openWindow(service)
    service.start()
    service.setWebContents(null)

    await vi.advanceTimersByTimeAsync(3 * 60_000)
    vi.setSystemTime(DUE + 90 * 60_000)
    const send = openWindow(service)

    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automationId)).toMatchObject([
        { status: 'skipped_missed', scheduledFor: DUE }
      ])
    )
    expect(send).not.toHaveBeenCalled()
    service.stop()
  })
})
