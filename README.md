# codex-usage-maxing

Read native Codex 5-hour session and weekly quota from the existing Codex CLI login. This repo is
the starter for a workflow runner that will spend leftover quota on configured repo maintenance
work without stealing quota from user-initiated sessions.

## Principles

- No CodexBar dependency.
- No API key setup.
- No second auth flow: reuse the user's existing Codex CLI login.
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

The first implementation uses Codex's native app-server API:

```json
{ "method": "account/rateLimits/read", "id": 1 }
```

It requires ChatGPT/Codex auth from the existing Codex CLI state. It does not ask for an API
key. The quota reader expects:

- `windowDurationMins: 300` → 5-hour session limit.
- `windowDurationMins: 10080` → weekly limit.

If either window is missing, the quota reader fails closed.

## Commands

```sh
bun run dev status
bun run dev init
```

`status` prints current native Codex quota. `init` writes a starter
`codex-usage-maxing.config.jsonc` in the current repo.

## Tooling

This repo follows the fast-tooling setup from Christoph Pojer's post:

- Oxlint with `@nkzw/oxlint-config`.
- Oxfmt instead of Prettier.
- Strict TypeScript defaults (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  unused checks, and NodeNext modules).

## First workflow shape

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
