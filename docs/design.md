# Target system design

Current implementation: `init` writes starter config and `status` reads native Codex quota. The
sections below describe the runner shape this repo is being built toward.

Status: experimental. Market the repository as an early quota-reader/runner scaffold until the
workflow scheduler, interruption loop, and publishing path are implemented and hardened.

## Goal

Run configured Codex workflows during off-peak/idle periods to spend quota that would otherwise
expire, while always yielding to user-initiated Codex work.

## Source of truth

Use native Codex only:

- `codex app-server --listen stdio://`
- `account/rateLimits/read`
- `account/rateLimits/updated`

No CodexBar. No API key. No reauth beyond the user's existing `codex login`.

## Quota windows

- 5-hour session: `windowDurationMins === 300`
- Weekly: `windowDurationMins === 10080`

Both windows are required before starting automation. If quota is unknown, do not run.

## User-priority rule

Target behavior: any active Codex work not owned by the orchestrator interrupts automation
immediately.

Planned detection sources, in order:

1. Codex app-server thread state and `thread/status/changed` notifications.
2. Active thread IDs owned by this orchestrator in the local ledger.
3. Process fallback: unknown `codex` process means user work.

Local user work gets a strong guarantee. Remote/cloud Codex work cannot be known before it uses
quota, so reserve thresholds and frequent quota updates remain required.

### Remote/VPS sessions

Codex app-server thread state is local to a machine and `CODEX_HOME`. If the same account is running
Codex on a VPS, another workstation, or a cloud/GitHub Codex surface, a local runner cannot see the
remote active thread before it spends quota. There is no known native cross-host "active turn"
reservation API.

Conservative policy for MVP:

- Treat local monitored hosts as strongly preemptive: active user thread interrupts automation.
- Treat remote/unmonitored hosts as quota-only signals: unexpected 5h/weekly usage drop pauses new
  automation and interrupts any current local automation.
- Keep user reserve thresholds even near reset unless explicitly configured otherwise.
- Later support an optional `remoteHosts` monitor that connects over SSH and runs the same
  app-server thread-state check on the VPS.

## Planned workflow adapters

- `codex-skills`: load user-selected skill files into a bounded Codex prompt.
- `codex-prompt`: run a user prompt file.
- `command`: run an arbitrary command and collect artifacts.
- `findings-to-fix`: convert findings JSON into one bounded fix workflow.

## Planned publishing

- Managed worktree per job.
- One active job globally for MVP.
- One draft PR per repo/workflow.
- Validation commands must pass before publishing.
- No auto-merge.
