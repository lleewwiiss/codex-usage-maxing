# codex-usage-maxing

> Experimental. This repo currently ships native Codex quota and local-activity readers plus starter
> config. The autonomous workflow runner is the target design, not production-ready behavior yet.

Read native Codex 5-hour session quota, weekly quota, and local thread activity from the existing
Codex CLI login. This repo is the starter for a workflow runner that spends leftover quota on
carefully chosen repo maintenance work without stealing quota from user-initiated sessions.

This is not for blind tokenmaxxing. Using every available session to generate new features is a
fast way to create tech debt, AI slop, and subtle bugs. The opinionated use case is: be calculated
about what you build, keep risky/product work human-directed, and spend excess quota paying down
known debt with review-heavy, validation-backed workflows.

## Principles

- No CodexBar dependency.
- No API key setup.
- No second auth flow: reuse the user's existing Codex CLI login.
- Spend spare quota on paying down debt, not spraying new product surface area.
- Target runner behavior: user Codex work wins; automation interrupts and resumes later.
- Target runner behavior: workflows are repo-scoped and user-defined.
- Target publishing behavior: draft PRs only by default.

## Install/dev

```sh
bun install
bun run check
bun run build
```

The CLI expects the user to have already run:

```sh
codex login
```

## Native quota source

The quota reader uses Codex's native app-server API:

```json
{ "method": "account/rateLimits/read", "id": 1 }
```

It requires ChatGPT/Codex auth from the existing Codex CLI state. It does not ask for an API
key. The quota reader expects:

- `windowDurationMins: 300` → 5-hour session limit.
- `windowDurationMins: 10080` → weekly limit.

If either window is missing, the quota reader fails closed.

## Native local activity source

The local activity reader uses Codex's native thread API:

```json
{ "method": "thread/list", "params": { "useStateDbOnly": true }, "id": 1 }
```

Any thread with `status.type === "active"` is treated as user activity unless its thread ID is
explicitly marked as owned by this orchestrator. Unknown or malformed thread statuses fail closed,
so the runner should not start automation when it cannot prove the local host is idle.

## Important limitation: remote/VPS Codex sessions

Local Codex activity detection can only see Codex app-server state and processes on machines/Codex
homes the runner monitors. If you start Codex on a VPS, another laptop, GitHub/cloud Codex, or any
other remote environment using the same account, this repo cannot interrupt that remote work before
it consumes quota.

The planned runner should handle that conservatively:

- keep session and weekly reserve thresholds;
- poll `account/rateLimits/read` / subscribe to `account/rateLimits/updated`;
- pause when quota drops unexpectedly;
- optionally support configured remote monitors later, e.g. SSH to a VPS and query that host's
  Codex app-server.

So the user-priority promise is strong for monitored local hosts, and conservative for unmonitored
remote hosts.

## Commands

```sh
bun run dev activity
bun run dev status
bun run dev init
```

`activity` prints local Codex thread activity, `status` prints current native Codex quota, and
`init` writes a starter `codex-usage-maxing.config.jsonc` in the current repo.

## Tooling

This repo follows the fast-tooling setup from Christoph Pojer's post:

- Oxlint with `@nkzw/oxlint-config`.
- Oxfmt instead of Prettier.
- Strict TypeScript defaults (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  unused checks, and NodeNext modules).

## First workflow shape

Start with review-heavy skills that produce bounded findings, avoid live side effects, and have a
clear validation command. Good candidates:

- [`openclaw/agent-skills` `autoreview`](https://github.com/openclaw/agent-skills/tree/main/skills/autoreview)
  for a general autonomous review pass.
- [`lleewwiiss/codex-agents` `improve-codebase-architecture`](https://github.com/lleewwiiss/codex-agents/tree/main/skills/improve-codebase-architecture)
  for bounded architecture cleanup plans.
- [`lleewwiiss/codex-agents` `improve-test-suite`](https://github.com/lleewwiiss/codex-agents/tree/main/skills/improve-test-suite)
  for test-suite simplification and higher-signal coverage.
- [`lleewwiiss/codex-agents` `review-and-simplify-changes`](https://github.com/lleewwiiss/codex-agents/tree/main/skills/review-and-simplify-changes)
  for post-change simplification passes.
- [`lleewwiiss/codex-agents` `systematic-debugging`](https://github.com/lleewwiiss/codex-agents/tree/main/skills/systematic-debugging)
  for repos with known failing tests or flaky behavior.

For now, point `skills` at local `SKILL.md` files from a cloned or vendored skill repo. Avoid
workflows that deploy, publish, rotate secrets, or mutate shared services unless the runner has an
explicit approval gate for that repo.

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
          "prompt": "Find one bounded test-suite improvement. Make one coherent PR.",
          "validation": ["bun test", "bun run typecheck"],
        },
      ],
    },
  ],
}
```

See [`docs/design.md`](docs/design.md) for the target runner design.
