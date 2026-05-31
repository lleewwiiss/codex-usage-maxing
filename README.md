# codex-usage-maxing

[![npm](https://img.shields.io/npm/v/codex-usage-maxing?label=npm)](https://www.npmjs.com/package/codex-usage-maxing)

Experimental Codex quota/activity CLI and runner scaffold.

Goal: use leftover 5-hour and weekly Codex sessions to pay down tech debt, not to spray new product
surface area. Blind tokenmaxxing creates tech debt, AI slop, and subtle bugs. This project is for
calculated, repo-scoped cleanup work. Target behavior: validation-backed draft PRs.

## Use it

Requires an existing Codex CLI login:

```sh
codex login
```

Run from npm:

```sh
npx --yes codex-usage-maxing status
npx --yes codex-usage-maxing activity
npx --yes codex-usage-maxing init
```

Local dev:

```sh
bun install
bun run check
bun run build
```

## What works now

- `status`: reads native Codex 5-hour and weekly quota.
- `activity`: detects active local Codex threads so user work wins.
- `init`: writes a starter repo config.
- PR-slot planner: pure idempotency logic for reusing managed worktrees/PRs.

The scheduler, interruption loop, workflow execution, GitHub reads, and draft PR publishing are still
target design, not production behavior yet.

## PR slots

The target runner is conservative: it tracks one open draft PR per repo workflow config. The runner
owns this; prompts do not.

- Work key: GitHub repo + base branch + workflow `id`.
- Two different goals in one repo should be two workflow configs with different `id`s.
- Repeated triggers are idempotent: current slots are skipped; stale slots reuse the same managed
  worktree, branch, and draft PR.
- The runner checks local worktree state, pulls the latest base, runs the configured workflow, then
  pushes to the same or a new draft PR.
- If a human touches the PR, marks it ready for review, removes the marker, pushes new commits, or
  closes it, automation backs off or cools the slot down.
- If every configured slot already has an open or cooling-down PR, leftover quota stays unused.

This intentionally leaves some quota on the table. Better that than duplicate PRs and review churn.

## Native Codex signals

No API key. No second auth flow. Uses the user's existing Codex CLI auth.

- quota: `account/rateLimits/read`
  - `windowDurationMins: 300` → 5-hour session limit
  - `windowDurationMins: 10080` → weekly limit
- local activity: `thread/list`
  - any non-owned `status.type === "active"` thread blocks automation
  - malformed or unknown thread payloads fail closed

Remote/VPS Codex sessions are only visible on hosts the runner monitors. For unmonitored hosts, the
runner must rely on reserve thresholds and unexpected quota drops.

## Good workflow targets

Start with review-heavy skills that produce bounded findings, avoid live side effects, and have a
clear validation command:

- [`openclaw/agent-skills` `autoreview`](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview)
- [`lleewwiiss/codex-agents` `improve-codebase-architecture`](https://github.com/lleewwiiss/codex-agents/tree/main/skills/improve-codebase-architecture)
- [`lleewwiiss/codex-agents` `improve-test-suite`](https://github.com/lleewwiiss/codex-agents/tree/main/skills/improve-test-suite)
- [`lleewwiiss/codex-agents` `review-and-simplify-changes`](https://github.com/lleewwiiss/codex-agents/tree/main/skills/review-and-simplify-changes)

Avoid workflows that deploy, publish, rotate secrets, or mutate shared services unless the repo has
an explicit approval gate.

## Config shape

```jsonc
{
  "repos": [
    {
      "path": "~/Development/example",
      "base": "main",
      "workflows": [
        {
          // Unique per repo/base. This forms the managed PR slot with repo + base.
          "id": "improve-tests",
          "type": "codex-skills",
          "skills": ["~/.agents/skills/improve-test-suite/SKILL.md"],
          "prompt": "Find one bounded test-suite improvement. Make one coherent PR.",
          "validation": ["bun test", "bun run typecheck"],
        },
      ],
    },
  ],
}
```

See the [target runner design](https://github.com/lleewwiiss/codex-usage-maxing/blob/master/docs/design.md).
