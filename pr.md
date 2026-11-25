# feat(notifications): opt-in setting to hold Claude's "finished" for background shells

## ELI5

When Claude starts a build or test in the background and ends its turn, Orca says "finished" straight away, which is wrong, then says it again when the build ends and Claude wraps up. This adds an opt-in switch, "Wait for background shells": with it on, Orca waits for those shells, for up to 30 minutes, and alerts once. It's off by default, so nothing changes unless you turn it on.

## What Changed

**Before:** a user turn that leaves a background Bash shell running alerts at Stop, and again when the shell's wake-up turn ends.

**After, with the setting on:**
- A background Bash shell the main agent started holds "finished" for at most 30 minutes after the first held shell started. After that, Orca alerts as it does today.
- Monitor tool tasks, `type: monitor` tasks (such as artifact watches), crons, a sub-agent's shells and anything Orca can't classify never hold. If one is running, the turn alerts as today.
- Wake-up turns check again, and the turn alerts once no held shell is left running. A wake-up turn that starts another shell can't push the alert past the first deadline.

**With the setting off (the default):** behaviour is the same as main. The hold is never recorded, so every stamp has the same value as before.

**Mechanism.** It follows #36992's design:
- The decision stays at the hook listener's `turnCompletedAt` stamp in `claude-events.ts`. Notification consumers are unchanged, and nothing new goes over the wire.
- New `claude-shell-finish-hold.ts` decides at Stop. It skips the stamp only if every running task that isn't a sub-agent is a Bash shell the main agent started, still inside its 30-minute window. It then records that deadline for the pane.
- The cap reuses the existing owed-notification expiry timer (desktop main and the WSL guest). The timer now also wakes at the hold deadline and stamps the held turn without waiting for another hook event. No new timer.
- A user prompt, SessionStart, a replaced session, a done row or pane cleanup ends the hold.
- The setting, `claudeFinishedWaitsForBackgroundShells`, is per host and sits under Agent task complete. The host that runs the hooks makes the decision, so the toggle follows the Settings host picker, like the Codex history-sharing toggle (`codexShareHistoryAcrossAccounts`). The two toggles could share one hook later.
- Desktop main and orcad pass the listener a function that reads the setting each time it is needed, so neither of them needs a settings subscription.

## Why

#36992's default stays: background shells still count as monitoring. This PR only lets people whose shells are nearly all finite opt in.

thomplth's [count from 584 Claude Code sessions](https://github.com/stablyai/orca/issues/30091#issuecomment-6569494669) shows who that is: 165 turns ended with a background shell still running, and each sent a wrong early "finished". Every one of those shells exited on its own (builds, test suites, VM end-to-end runs, benchmarks). The median was 6 minutes, and 96% finished within 30. The 30-minute cap covers the dev-server case: a server that never exits delays the alert by 30 minutes at most, and can't silence the turn.

## Linked Issue

Fixes #30091

## Visual Proof

Settings › Notifications, before (main) and after (new toggle under Agent task complete, off by default):

[[SCREENSHOTS]]

## Testing

- Listener test (`claude-shell-finish-hold.test.ts`): a shell still running at Stop holds the turn, and it gets one stamp, after the wake-up turn.
- Hook server tests over loopback with fake timers (`server-claude-shell-finish-hold-expiry.test.ts`):
  - the turn is stamped at 30 minutes with no further hook event;
  - a shell chained by a wake-up turn keeps the first deadline.
- Each test failed before the change.
- Passing: typecheck, lint, format, the changed-code quality check and the localization pass.
- Full suite: the only failures are 12 "survives a restart through the status file" agent-hook server tests. They fail the same way on origin/main sources.
- TODO: platforms tested by hand.

- [ ] I manually tested these changes locally
- [x] Automated tests added/updated, or explained why not below
- [x] Every added test fails without this change and avoids the [test anti-patterns](https://github.com/stablyai/orca/blob/main/docs/agents-md-refs/test-antipatterns.md)

## Risk

The riskiest part is that every Claude `turnCompletedAt` stamp now goes through the new `claudeTurnCompletedAt` function. With the setting off it returns what the old inline expression did.

Known limits with the setting on:
- SSH hosts on the relay route, tmux inner panes and the WSL relay behave as today. The setting has no effect there.
- If the listener restarts mid-hold, the hold is lost. A shell that never ends then alerts only when it exits.
- Hitting the cap gives two alerts, one at the cap and one when the shell ends. The main branch already sends the same two today, just earlier.
- On an older host the toggle is disabled and reads "Update Orca on <host> to change this setting there."

Backing out is a plain revert.

**Level:** Low

## AI Disclosure

Written with Claude Code (Claude Opus 5.5). Independent AI reviews covered correctness and merge-ability, and their findings were fixed.

## Review

See AI Disclosure for the AI reviews, and Notes for compatibility.

## Agent skill upstream boundary

- [x] Not applicable, or this change copies or mechanically translates no upstream skill-installer source, tests, fixtures, registry entries, path tables, comments, or documentation.

## Notes

- **Security:** no new inputs. The setting is a boolean read and written through the existing `settings.get` and `settings.update` calls.
- **Cross-platform:** no platform-specific code.
- **Remote SSH and mixed versions:** the host that runs the hooks reads its own setting. An older host keeps today's behaviour and the toggle asks you to update it. No wire field is added.
- **Mobile:** phone pushes read the same stamp, so they follow the setting.
- **Performance:** with the setting off, the check returns at its first test. With it on, Stop loops over the running task ids.
- **UI:** one toggle nested under Agent task complete, with its strings in `en.json`.

X handle: TODO

## Checklist

- [x] This PR is small and focused
- [x] I explained what changed and why (ELI5, the user-facing before/after, the mechanism, and why over the alternatives)
- [x] I stated the risk: what could break, for whom, and how to back it out
- [ ] Before/after screenshots or videos attached for UI changes, or `N/A` with reason
- [x] Self-reviewed for correctness, security, and performance
- [x] Cross-platform, SSH/remote, and path/shortcut impact considered (or N/A)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass (or CI will cover; local preferred)
