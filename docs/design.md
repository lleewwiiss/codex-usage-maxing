# Target system design

Current implementation: `init` writes starter config, `status` reads native Codex quota, and
`activity` reads native local Codex thread activity. The sections below describe the runner shape
this repo is being built toward.

Status: experimental quota-reader/runner scaffold. The idempotent PR-slot planner is implemented as
pure logic. The workflow scheduler, interruption loop, GitHub reads, and publishing path are not
implemented yet.

## Goal

Run configured Codex workflows during off-peak/idle periods to spend quota that would otherwise
expire, while always yielding to user-initiated Codex work.

## Source of truth

Use native Codex only:

- `codex app-server --listen stdio://`
- `account/rateLimits/read`
- `account/rateLimits/updated`
- `thread/list`
- `thread/status/changed`

No CodexBar. No API key. No reauth beyond the user's existing `codex login`.

## Quota windows

- 5-hour session: `windowDurationMins === 300`
- Weekly: `windowDurationMins === 10080`

Both windows are required before starting automation. If quota is unknown, do not run.

## User-priority rule

Target behavior: any active Codex work not owned by the orchestrator interrupts automation
immediately.

Planned detection sources, in order:

1. Codex app-server thread state from `thread/list`, then `thread/status/changed` notifications for
   live preemption.
2. Active thread IDs owned by this orchestrator in the local ledger.
3. Process fallback: unknown `codex` process means user work.

Implemented now: snapshot polling via `thread/list`. The scheduler should pass its owned thread IDs
so any active, non-owned thread immediately blocks or interrupts automation.

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
- One open draft PR per repo workflow config.
- Validation commands must pass before publishing.
- No auto-merge.

## Managed PR slots

GitHub PRs are the durable registry. Local state can cache in-flight process/thread IDs, but it is
not the source of truth for duplicate prevention.

The default unit is a PR slot:

```txt
slotKey = githubRepo + baseBranch + workflow.id
```

`workflow.id` is the user-visible config identity. Different goals in the same repo should be
separate workflow configs with separate IDs, for example `improve-tests`, `autoreview`, and
`simplify-architecture`. Config hashes are staleness metadata, not slot identity, so editing a prompt
or validation command cannot accidentally create a second PR for the same goal.

`githubRepo` is resolved by the runner from the repo remote before planning; it does not need to be
hand-written in the starter config.

Managed PRs should be draft PRs with:

- branch prefix: `codex-usage-maxing/<workflow.id>/...`
- label: `codex-usage-maxing`
- hidden body marker containing schema version, slot key, workflow ID, config hash,
  `createdBaseSha`, `lastSyncedBaseSha`, and `lastManagedHeadSha`

Before starting any workflow for a repo, reconcile managed PRs:

1. If user Codex activity is detected, stop.
2. If quota/reserve policy does not allow a run, stop.
3. For each workflow config, compute its slot key and deterministic branch/worktree name.
4. Check the local managed worktree. Missing is fine; dirty or wrong branch freezes the slot.
5. Fetch open and recently closed managed PRs for the repo.
6. If that slot has a current open managed PR, skip it.
7. If that slot has a stale open managed PR, reuse the same worktree, branch, and draft PR.
8. If that slot is cooling down from a merged or closed PR, skip it.
9. Only create a new draft PR when the slot has no open PR and no cooldown.

The idempotent execution path is owned by the runner, not by the agent prompt:

```txt
trigger
  -> check quota and local user activity
  -> compute repo/workflow slot
  -> inspect local managed worktree
  -> inspect matching managed PRs
  -> fetch latest base branch
  -> checkout or create deterministic managed branch
  -> sync branch with latest base
  -> run configured skill/workflow in that worktree
  -> run validation
  -> push with lease to the same or new draft PR
```

The runner skips already-current slots instead of spending quota again. A slot becomes stale when the
base SHA or workflow config hash changes. Stale slots rerun against the same branch/PR, so repeated
triggers cannot create duplicate PRs for the same repo workflow config.

Automation freezes for an open PR if a human engages: ready-for-review, removed label/marker,
unexpected head SHA, wrong branch, or commits not authored by the runner. Closed and merged managed
PRs create a cooldown for that slot. If every configured slot is open or cooling down, unused quota
expires rather than creating duplicate work.
