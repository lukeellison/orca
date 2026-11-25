# Orca scheduled jobs: one-shot, missed runs, context

2 Nov 2026. Builds on `durable-scheduling-recommendation.md` and the `schedule-job` skill. Nothing pushed, no PR or issue opened, installed Orca untouched.

## TL;DR

- **One-shot: don't build it, someone did today.** Open upstream PR [#37432](https://github.com/stablyai/orca/pull/37432) (issue #37423, outside contributor, opened 2 Nov) adds `--trigger 'ONCE=<UTC ISO>'`. After its time passes the job pauses itself. Desktop, mobile, CLI, docs, 6 languages. No maintainer reply yet.
  - Core design is sound. Three gaps for us (below): UTC-only strict input, reschedule doesn't re-enable, any skip at fire time uses the job up.
  - A competing PR would duplicate it. Better: Luke comments on #37432 with the gaps, or builds from it.
- **Window closed = run lost: fixed on a local branch.** ~15 lines + tests, 2 commits. No open upstream PR covers it.
  - Branch `feat/automation-defer-no-window` in `~/coding/tools/orca-one-shot` (git worktree of `~/coding/tools/orca`), commits `83ada062e8a`, `10ccf36b3a9`.
  - Now a run due while the window is closed **waits**. When a window opens it runs if still inside grace, else it's logged `skipped_missed`.
  - 531/531 automation tests pass; typecheck, lint and `pnpm check:changed` (29/29) pass. Not yet tried in a running app.
- **Context: fresh session + pointer to the old one. Agree with Luke's lean.** Already what `schedule-job` does. No Orca change needed.
- **Hub visibility: no Orca change needed.** `list/runs --json` already show it. Two new signals to add to `check-jobs.py` (below).

## 1. How Orca automations work today (verified in code, origin/main `cbb743f07bd`)

- **Storage:** JSON records in SQLite, `<userData>/profiles/<id>/profile-state.db`. Runs kept per job, max 100.
- **Schedule field:** one string, `rrule`, holding either a 5-field cron or a tiny RRULE (`FREQ` hourly/daily/weekly, `BYHOUR`, `BYMINUTE`, `BYDAY` only).
  - Other RRULE keys are **silently dropped**: `FREQ=DAILY;COUNT=1` runs daily forever (issue #35894). So no hidden one-shot exists.
  - `--timezone` is **a label only**. Matching uses the clock of whichever machine runs the scheduler. Orca's docs claim otherwise. On a UTC VPS, "09:00" means 09:00 UTC.
- **Scheduler:** in Orca's main process, ticks every 60 s (`src/main/automations/service.ts`). When a job is due it takes the latest due time; if that's older than grace → `skipped_missed`; else launches. Only the latest missed time catches up; older ones vanish without a row.
- **Launch:** main asks the window (renderer) to start the agent terminal. `orca serve` and the SSH-host server (orcad) have a windowless launcher; the desktop app doesn't use it.
- **The window bug:** on macOS, closing the window keeps the app and timer running but leaves no renderer. The first due run was logged `skipped_unavailable` ("No Orca window was available"), later ones folded into that row, and the job moved on each time. An existing test asserted this.
- **Resume:** Orca blocks resume flags in `--extra-agent-args` on purpose (`src/shared/automation-extra-agent-args.ts`). `--reuse-session` only types into a still-open idle terminal from the job's previous run.

## 2. One-shot trigger

### Upstream PR #37432 (static review only: running an outside PR's code was refused here, so it was read, not built)

```sh
orca automations create ... --trigger 'ONCE=2026-11-10T20:04:00.000Z' --missed-run-grace-minutes 10080
```

- Stored as `ONCE=<UTC instant>` in the existing `rrule` field. An absolute instant, so no DST or host-timezone bugs.
- Fires once. Within grace after sleep/quit → runs once on wake. Beyond grace → `skipped_missed`.
- After its time is processed: `enabled: false`, `nextRunAt` kept at the fire time. Re-enabling a past one is refused with a clear error.
- Hub can read state from `list --json`: enabled + future `nextRunAt` = scheduled; disabled + past `nextRunAt` = used up. `runs --json` says fired vs missed vs skipped.

**Gaps that matter to us** (ranked; confirmed in the diff):

1. **Any skip at fire time uses the job up.** The job is paused whenever its time is *processed*, not when it *runs*. Closed window, missing workspace, failed launch, or failed precheck → paused, never retried.
   - The closed-window case is fixed by our branch (section 3): the job stays due until a window has loaded.
   - Precheck failing = "nothing to do", so using the job up is arguably right. Should be documented.
2. **Input is UTC-only and strict:** must end exactly `:00.000Z`. `20:04Z` or `+00:00` is rejected with a bare "Invalid automation trigger". A hub converting local → UTC by hand risks being an hour off in summer time.
   - Suggest: accept any ISO with offset, or `--at "2026-11-10 20:04"` in local time, normalised to UTC on save.
3. **Rescheduling doesn't re-enable.** `edit --trigger 'ONCE=<new future>'` leaves it paused unless `--enabled` is also passed. Same in the desktop editor.
4. Minor: a repeat skip with the same error folds into the previous run row, so the hub may find no row whose `scheduledFor` equals a rescheduled time. No capability flag, so new UIs offer `ONCE=` to old remote hosts (which reject it safely).

Full review: scratchpad `pr-37432-review.md` (path in "Files" below).

### If #37432 stalls

Same design, done ourselves: `ONCE=` with the input fix (2) and reschedule fix (3) built in. Most of the size is the desktop + mobile pickers and 6 languages, not the scheduler. Don't start this while #37432 is live.

### Meanwhile (no build needed)

The `schedule-job` workaround stays valid: dated cron + year precheck + the job disables itself at the end. With #37432 it becomes `--trigger 'ONCE=…'` and the self-disable line goes.

## 3. Window-closed fix (prototyped)

Two commits on `feat/automation-defer-no-window`, both needed:

**Commit 1 `83ada062e8a`: keep the run due** (`src/main/automations/service.ts`, in `evaluateAutomation`):

```ts
// macOS keeps running with no window: stay due so the next renderer-ready runs it within grace.
if (refusal?.errorCode === 'noDispatchHost') {
  return
}
```

- The job is not marked run and `nextRunAt` doesn't move. Each tick re-checks it in memory (no write, no log).
- Window reopens → renderer ready → due jobs run if inside grace. Past grace → one `skipped_missed`.
  - Grace is measured from the *latest* due time. For a job that repeats more often than its grace (e.g. hourly, 12 h grace) it never expires: it waits silently however long the window is closed, then runs once. Earlier due times leave no row (same as after a quit today).
- Host gone, workspace gone, WSL moves: unchanged, checked before this.
- `orca serve` / orcad unaffected: they always have the windowless launcher.

**Commit 2 `10ccf36b3a9`: say "ready" only once projects have loaded** (`useAutomationDispatchEvents.ts`, `use-app-shell-services.ts`, ~10 lines)

- Found by review: a reopened window told main "ready" the moment it mounted, before its project list loaded. Main then sent every waiting run at once, and the window logged each as "target project no longer available". Commit 1 alone would have turned "skipped while closed" into "skipped on reopen".
- Now "ready" waits for `workspaceSessionReady` (projects + session loaded; also set on a degraded boot, so a bad start can't hold jobs forever).
- Also fixes the same race at app startup: upstream issue #12318. Open PR #18305 contains the same renderer change plus a retry; if both land they conflict but agree.

- Composes with #37432: its auto-pause runs in the step commit 1 skips, so a one-shot due while closed stays due instead of being used up.

**Tests**
- `automation-closed-window-deferral.test.ts` (2 tests: reopen inside grace → runs; past grace → one `skipped_missed`). Failed before (`skipped_unavailable`), pass after. Removed the old test that asserted the bug.
- `useAutomationDispatchEvents.readiness.test.tsx` (real React hook render): "ready" not sent until the session is loaded. Failed before, passes after.

**Evidence:** `pnpm test src/main/automations src/shared/automation- src/renderer/src/hooks/useAutomationDispatchEvents` → 58 files, 531 tests pass (re-run by me). `pnpm tc`, oxlint, oxfmt, `pnpm check:changed` (29/29) pass (subagent output, saved).

**Not tested in a running app.** Unit tests only. Before relying on it, try it in `pnpm dev`: create a job a few minutes out, close the window, wait past the time, reopen. (Not done here: the brief ruled out creating automations while another worker tests them.)

**Left out on purpose (YAGNI):**
- Launching the agent with no window (the windowless launcher on desktop). Fires on time even when closed, but unverified whether a reopened window adopts the terminal. Only worth it if waiting-for-reopen proves not enough.
- Manual `orca automations run` with no window still logs `skipped_unavailable`.
- Small race: window closes between "dispatch" and the hand-off → still `skipped_unavailable`.

**Upstream fit:**
- Related: #12318 (startup race; PRs #18305, #29194 open). #29194 also defers while a window is attached but not ready, and **deliberately keeps** the no-window skip; an outside contributor's choice, not a maintainer's. A PR should cite all three and explain the difference.
- #28258 (88 silent skips) and failure-alert PRs #27763 / #36467 show maintainers care.
- Needs: a linked issue (`Fixes #N`, required for outside PRs), the template sections, an AI-review summary. Could be a new issue "runs due while the macOS window is closed are lost".

## 4. Context: resume vs fresh + pointer

**Recommendation: fresh session with a self-contained brief, plus the origin session id as a pointer; fork it ad hoc only for a missing fact.** Same as Luke's lean.

Why:
- **Orca is built for fresh runs.** Resume flags are deliberately blocked in extra args. A "resume session X" job type would be a new upstream feature fighting that design.
- **Resuming the origin session is risky:** it may still be open in another terminal (two writers on one transcript), its worktree may be gone, and a long session is slow and costly to reload and may compact away the very detail you need.
- **A fresh brief is cheap and predictable:** right model per job (haiku for checks), the same result whether it runs tonight or after a week of sleep, easy to read in run history.
- **The fork covers the gap:** `claude -p --resume <id> --fork-session` reads the old session without changing it.
  - Verified today: a session made in folder A was resumed by id from folder B with `--fork-session` and recalled a codeword. So the id alone is enough; the skill's `cd <folder>` is harmless (and keeps cwd-relative paths right) but not required.
  - Cost: each fork reloads the whole origin session. Keep it a fallback.
- **When resume would win:** long interactive threads where the "brief" would be the whole conversation. Then the job should just escalate to the hub with `claude --resume <id>` for Luke to open, as the skill already says.

No Orca change needed. Possible tiny upstream nicety later (YAGNI now): a `sourceSessionId` field shown in the UI. The name tag `[<8-char id>]` already does this.

## 5. Hub visibility

Already enough in `orca automations list/runs --json`. Two signals to add to `check-jobs.py` **in the same step as** switching to a build with these changes (not edited: `~/.claude` was out of bounds):

- **Waiting for a window:** `enabled` and `nextRunAt` more than ~2 min in the past = due but no window. Tell Luke to open Orca.
  - Must ship with the build: after the fix a closed window writes **no** run row, so today's `skipped_unavailable` alarm goes quiet.
  - Known false positives: a job with an unreadable schedule also keeps a past `nextRunAt` (it already logs `skipped_unavailable`, so tell them apart by that row).
- **One-shot done (with #37432):** `rrule` starts `ONCE=`, `enabled: false`, `nextRunAt` past → read its last run; prune once checked. Replaces the name-date heuristic.

Also worth knowing (no change): `skipped_missed` after a long closed/quit period is the only trace; earlier missed times leave no row.

## 6. Running Luke's own build

Two routes. Both use the checkout at `~/coding/tools/orca` (a separate worktree keeps Luke's own `feat/notify-wait-for-background-work` branch untouched).

Setup once: Node 24 (`nvm use 24`) and pnpm 12.14.0. Here corepack's pnpm is broken; `npx -y pnpm@12.14.0` works.

```sh
cd ~/coding/tools/orca && git fetch origin
git worktree add ../orca-luke origin/main && cd ../orca-luke
git checkout -b luke/build
git merge feat/automation-defer-no-window            # our fix
git fetch origin pull/37432/head:pr-37432-once && git merge pr-37432-once   # optional: one-shot (outside code: read it first)
pnpm install
```

- **A. Try it: `pnpm dev`.** Runs beside the installed Orca with its own profile (`~/Library/Application Support/orca-dev-wt/<hash>`), so no clash. Good for checking the fix and `ONCE=`. Don't seed it from the real profile (`--seed-profile`) while the installed Orca runs: both would hold the same jobs and **both would fire them**.
- **B. Daily driver: packaged app.** `ORCA_COMPUTER_MACOS_SIGN_IDENTITY=- pnpm build:unpack` (also needs `pnpm -C mobile install --frozen-lockfile` first).
  - **Verified:** built `dist/mac-arm64/Orca.app` from the fix branch (commit 1 only; rebuild for commit 2) in a few minutes. Not launched (it would open Luke's real profile).
  - It has the same bundle id as the installed app (`com.stablyai.orca`), so it uses **the same profile and jobs**. Quit the installed Orca first; never run both, or both schedulers fire.
  - Unsigned (only ad-hoc). Luke's Apple Development cert is expired. macOS may need right-click → Open the first time.
  - Not checked, likely: it can't read secrets the signed app encrypted (Orca's CONTRIBUTING says so for dev builds) → expect to sign in again.
  - Its version reads `1.4.214` (a stale number on main; the code is newer than the installed 1.4.246). So Orca's updater will probably offer the official release, which would drop the fix. Don't accept updates in it. Switching back to the installed app is safe (same profile schema).
  - **The `orca` on PATH is the installed app's CLI** (`/Applications/Orca.app/Contents/Resources/bin/orca`), and the CLI validates triggers itself. So with #37432 merged in, `--trigger 'ONCE=…'` is rejected unless you call `dist/mac-arm64/Orca.app/Contents/Resources/bin/orca` (or put that first on PATH).
  - Each upstream release means rebase + rebuild. Fine short-term; the real goal is getting the fix merged.
- **Simplest option:** don't switch. Keep "minimise Orca, never close its window" until upstream merges a fix; the hub's `check-jobs.py` already flags `skipped_unavailable`.

## 7. What's left

- Luke decides: comment on #37432 with gaps 1–3? File an issue for the window fix and PR it? (Both public; not done.)
- Not tested: the fix in a running app (unit tests only; try in `pnpm dev` first), the packaged build on Luke's real profile, #37432 at all (static read only).
- After a build: add the two signals to `check-jobs.py`; drop "minimise, never close the window" from `schedule-job`.
- Separate upstream bugs worth an issue: `--timezone` is ignored (docs wrong); RRULE `COUNT`/`UNTIL`/`INTERVAL` silently ignored (#35894 exists).

## Files

- Branch: `~/coding/tools/orca-one-shot` (worktree), `feat/automation-defer-no-window`, commits `83ada062e8a` + `10ccf36b3a9`.
- Scratchpad (session-only, `/private/tmp/claude-501/-Users-lukeellison-coding-temp-temp/6dbddb98-4978-4361-99dc-e3ce0c99cd88/scratchpad/`): `code-map.md` (automations code with file:line refs), `upstream.md` (related issues/PRs), `pr-37432-review.md`, `before.txt` / `check-changed2.txt` (test evidence), `build-unpack.log`.
