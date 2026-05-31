import type { WorkflowDefinition } from '../workflows/types.js';

export type CodexUsageMaxingConfig = {
  readonly activity: {
    readonly idleRequiredMinutes: number;
    readonly interruptOnUserCodex: boolean;
  };
  readonly codex?: CodexLaunchConfig;
  readonly daemon?: DaemonConfig;
  readonly quota: {
    readonly session: QuotaWindowPolicy;
    readonly weekly: QuotaWindowPolicy;
  };
  readonly repos: ReadonlyArray<RepoConfig>;
};

export type CodexLaunchConfig = {
  readonly askForApproval?: 'never' | 'on-failure' | 'on-request' | 'untrusted';
  readonly bin?: string;
  readonly extraArgs?: ReadonlyArray<string>;
  readonly model?: string;
  readonly sandbox?: 'danger-full-access' | 'read-only' | 'workspace-write';
};

export type DaemonConfig = {
  readonly interruptPollSeconds?: number;
  readonly intervalMinutes?: number;
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

export const DEFAULT_CODEX_LAUNCH_CONFIG = {
  askForApproval: 'never',
  bin: 'codex',
  sandbox: 'workspace-write',
} as const satisfies Required<Pick<CodexLaunchConfig, 'askForApproval' | 'bin' | 'sandbox'>>;

export const DEFAULT_DAEMON_CONFIG = {
  interruptPollSeconds: 30,
  intervalMinutes: 15,
} as const satisfies Required<DaemonConfig>;

export const defaultConfigText = `{
  // Native Codex quota and local activity. Requires existing \`codex login\`.
  "daemon": {
    "intervalMinutes": ${DEFAULT_DAEMON_CONFIG.intervalMinutes},
    "interruptPollSeconds": ${DEFAULT_DAEMON_CONFIG.interruptPollSeconds}
  },
  "codex": {
    "bin": "${DEFAULT_CODEX_LAUNCH_CONFIG.bin}",
    "sandbox": "${DEFAULT_CODEX_LAUNCH_CONFIG.sandbox}",
    "askForApproval": "${DEFAULT_CODEX_LAUNCH_CONFIG.askForApproval}"
  },
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
          "prompt": "Find one bounded test-suite improvement. Make one coherent draft PR.",
          "validation": ["bun test", "bun run typecheck"]
        }
      ]
    }
  ]
}
`;
