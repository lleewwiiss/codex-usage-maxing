import type { WorkflowDefinition } from '../workflows/types.js';

export type CodexUsageMaxingConfig = {
  readonly activity: {
    readonly idleRequiredMinutes: number;
    readonly interruptOnUserCodex: boolean;
  };
  readonly quota: {
    readonly session: QuotaWindowPolicy;
    readonly weekly: QuotaWindowPolicy;
  };
  readonly repos: ReadonlyArray<RepoConfig>;
};

export type QuotaWindowPolicy = {
  readonly drainReserveRemaining: number;
  readonly drainWhenResetWithinMinutes: number;
  readonly minRemainingToStart: number;
  readonly reserveRemaining: number;
};

export type RepoConfig = {
  readonly base: string;
  readonly path: string;
  readonly workflows: ReadonlyArray<WorkflowDefinition>;
};

export const defaultConfigText = `{
  // Native Codex quota and local activity. Requires existing \`codex login\`.
  "quota": {
    "session": {
      "minRemainingToStart": 30,
      "reserveRemaining": 15,
      "drainWhenResetWithinMinutes": 45,
      "drainReserveRemaining": 5
    },
    "weekly": {
      "minRemainingToStart": 20,
      "reserveRemaining": 10,
      "drainWhenResetWithinMinutes": 480,
      "drainReserveRemaining": 3
    }
  },
  "activity": {
    "idleRequiredMinutes": 15,
    "interruptOnUserCodex": true
  },
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
          "validation": ["bun test", "bun run typecheck"]
        }
      ]
    }
  ]
}
`;
