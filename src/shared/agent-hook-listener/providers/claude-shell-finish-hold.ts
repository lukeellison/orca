import type { readClaudeBackgroundAgentTasks } from '../../claude-background-task-inventory'
import type { HookListenerState } from '../listener-state'
import { claudePaneHasRunningChildWork, resolveClaudePaneStatus } from './claude-pane-hold-evidence'

/** Opt-in: how long a Bash shell the main agent left running may hold its turn's "finished" (#30091). */
export const CLAUDE_SHELL_FINISH_HOLD_MS = 30 * 60_000

/** The earliest hold deadline when every running non-agent task is a main-agent Bash shell still inside its window. */
function claudeShellFinishHoldUntil(
  state: HookListenerState,
  paneKey: string,
  inventory: ReturnType<typeof readClaudeBackgroundAgentTasks>,
  now: number
): number | undefined {
  if (
    !state.claudeFinishedWaitsForBackgroundShells() ||
    !inventory.present ||
    inventory.hasUnlistedRunningNonAgentTask ||
    state.claudeActiveSessionCronPaneKeys.has(paneKey)
  ) {
    return undefined
  }
  const launched = state.claudeLaunchedBackgroundTasksByPaneKey.get(paneKey)
  let deadline: number | undefined
  for (const id of inventory.runningNonAgentTaskIds) {
    const until = launched?.get(id)?.holdsFinishUntil
    if (until === undefined || until <= now) {
      return undefined
    }
    deadline = Math.min(deadline ?? until, until)
  }
  return deadline
}

/** Stamp a turn that counts as finished now, unless only held Bash shells keep it open; then hold it instead. A user prompt or a done row ends the hold. */
export function claudeTurnCompletedAt(
  state: HookListenerState,
  paneKey: string,
  inventory: ReturnType<typeof readClaudeBackgroundAgentTasks>,
  turn: { finished: boolean; failed: boolean; settled: boolean }
): number | undefined {
  const now = Date.now()
  const shellsHoldUntil =
    turn.finished && !turn.failed
      ? claudeShellFinishHoldUntil(state, paneKey, inventory, now)
      : undefined
  // Why: shells chained by wake-up turns must not push the held turn past its first deadline.
  const heldUntil = state.claudeShellHeldFinishByPaneKey.get(paneKey)
  const holdUntil =
    shellsHoldUntil === undefined
      ? undefined
      : Math.min(heldUntil ?? shellsHoldUntil, shellsHoldUntil)
  if (holdUntil !== undefined && holdUntil > now) {
    state.claudeShellHeldFinishByPaneKey.set(paneKey, holdUntil)
    return undefined
  }
  if (turn.finished || turn.settled) {
    state.claudeShellHeldFinishByPaneKey.delete(paneKey)
  }
  return turn.finished ? now : undefined
}

/** At the deadline, announce a held turn that only monitoring work still keeps open, with no hook event. */
export function releaseExpiredClaudeShellFinishHold(
  state: HookListenerState,
  paneKey: string
): void {
  const now = Date.now()
  const until = state.claudeShellHeldFinishByPaneKey.get(paneKey)
  if (until === undefined || until > now) {
    return
  }
  state.claudeShellHeldFinishByPaneKey.delete(paneKey)
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  if (
    lead?.state === 'done' &&
    resolveClaudePaneStatus(state, paneKey, lead).workingMode === 'monitoring' &&
    claudePaneHasRunningChildWork(state, paneKey)
  ) {
    state.claudeLeadStateByPaneKey.set(paneKey, { ...lead, turnCompletedAt: now })
  }
}
