# codex-usage-maxing

[![npm](https://img.shields.io/npm/v/codex-usage-maxing?label=npm)](https://www.npmjs.com/package/codex-usage-maxing)

Experimental Codex quota daemon for calculated tech-debt PRs.

Blind tokenmaxxing creates tech debt, AI slop, and subtle bugs. This is for using leftover 5-hour and weekly Codex quota on bounded cleanup work: reviews, test-suite improvements, architecture simplification, and other validation-backed maintenance.

## Use

Requires an existing Codex CLI login.

```sh
codex login
npx --yes codex-usage-maxing init
# edit codex-usage-maxing.config.jsonc for your repos/workflows
npx --yes codex-usage-maxing run --dry-run
npx --yes codex-usage-maxing run
npx --yes codex-usage-maxing daemon
```

Or install it:

```sh
npm install -g codex-usage-maxing
codex-usage-maxing daemon --config ./codex-usage-maxing.config.jsonc
```

## What it does

- Reads native Codex 5-hour and weekly quota.
- Reads local Codex thread activity; user work wins.
- Selects one configured repo/workflow.
- Launches `codex exec` with strict slot instructions.
- Records the last `run`, `skip`, or `blocked` decision and log path.

The launched Codex agent owns git work: fetch latest base, create/reuse the managed worktree and branch, run the configured skill/workflow, validate, then create or update the same draft PR.

## Background visibility

Background skips/blocks are written to a small state file, not hidden in daemon stdout.

```sh
codex-usage-maxing runs
codex-usage-maxing status
```

`runs` does not need Codex to be healthy. It shows the latest decision, reason, repo, workflow, slot, branch, worktree, next check time, PID, and log path when available.

## Idempotent slots

Slot key: GitHub repo + base branch + workflow `id`.

Repeated triggers reuse the same managed branch/worktree/PR for that slot. If the base branch changed since the last run, the prompt tells Codex to fetch and sync latest upstream before continuing. If state is ambiguous or human-touched, Codex should stop and report instead of overwriting.

Different goals in one repo should be different workflow IDs.

## Native Codex signals

Uses the user's existing Codex CLI auth.

- quota: `account/rateLimits/read`
  - `windowDurationMins: 300` → 5-hour session limit
  - `windowDurationMins: 10080` → weekly limit
- local activity: `thread/list`
  - any non-owned active thread blocks or interrupts automation

Remote/VPS Codex sessions are only visible on the hosts you monitor. For unmonitored hosts, keep quota reserves conservative.

## Good workflow targets

Start with review-heavy, bounded skills:

- [`openclaw/agent-skills` `autoreview`](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview)
- [`lleewwiiss/codex-agents` `improve-codebase-architecture`](https://github.com/lleewwiiss/codex-agents/tree/main/skills/improve-codebase-architecture)
- [`lleewwiiss/codex-agents` `improve-test-suite`](https://github.com/lleewwiiss/codex-agents/tree/main/skills/improve-test-suite)
- [`lleewwiiss/codex-agents` `review-and-simplify-changes`](https://github.com/lleewwiiss/codex-agents/tree/main/skills/review-and-simplify-changes)

Avoid workflows that deploy, publish, rotate secrets, or mutate shared services unless the repo has an explicit approval gate.

## Repo/workflow config excerpt

`init` writes the full config, including quota and activity policy. One repo entry looks like this:

```jsonc
{
  "repos": [
    {
      "path": "~/Development/example",
      "base": "main",
      "workflows": [
        {
          "id": "improve-tests",
          "type": "codex-skills",
          "skills": ["~/.agents/skills/improve-test-suite/SKILL.md"],
          "prompt": "Find one bounded test-suite improvement. Make one coherent draft PR.",
          "validation": ["bun test", "bun run typecheck"],
        },
      ],
    },
  ],
}
```
