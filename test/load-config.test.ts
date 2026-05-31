import { describe, expect, test } from 'bun:test';

import { parseConfig } from '../src/config/load-config.js';

describe('parseConfig', () => {
  test('applies codex and daemon defaults while resolving repo paths', () => {
    const config = parseConfig(
      `{
        // JSONC comments and trailing commas are accepted.
        "activity": { "idleRequiredMinutes": 15, "interruptOnUserCodex": true },
        "quota": {
          "session": {
            "minRemainingToStart": 30,
            "reserveRemaining": 15,
            "drainWhenResetWithinMinutes": 45,
            "drainReserveRemaining": 5,
          },
          "weekly": {
            "minRemainingToStart": 20,
            "reserveRemaining": 10,
            "drainWhenResetWithinMinutes": 480,
            "drainReserveRemaining": 3,
          },
        },
        "repos": [{
          "path": "./repo",
          "base": "main",
          "workflows": [{
            "id": "review",
            "type": "codex-skills",
            "skills": ["./skills/review/SKILL.md"],
            "prompt": "Review one bounded area.",
          }],
        }],
      }`,
      '/tmp/project/codex-usage-maxing.config.jsonc',
    );

    expect(config.codex).toMatchObject({
      askForApproval: 'never',
      bin: 'codex',
      sandbox: 'workspace-write',
    });
    expect(config.daemon).toEqual({ interruptPollSeconds: 30, intervalMinutes: 15 });
    expect(config.repos[0]?.path).toBe('/tmp/project/repo');
    expect(config.repos[0]?.workflows[0]).toEqual({
      id: 'review',
      prompt: 'Review one bounded area.',
      skills: ['./skills/review/SKILL.md'],
      type: 'codex-skills',
    });
  });

  test('keeps JSONC comment and trailing-comma stripping out of strings', () => {
    const config = parseConfig(
      baseConfigText({
        prompt:
          'Keep literal // comment markers, escaped quotes like "ok", and comma pairs like , } inside strings.',
      }),
      '/tmp/project/codex-usage-maxing.config.jsonc',
    );

    expect(config.repos[0]?.workflows[0]).toMatchObject({
      prompt:
        'Keep literal // comment markers, escaped quotes like "ok", and comma pairs like , } inside strings.',
    });
  });

  test('rejects quota percentages outside 0..100 and nonpositive daemon intervals', () => {
    expect(() => parseConfig(baseConfigText({ sessionReserveRemaining: -1 }))).toThrow(
      'quota.session.reserveRemaining must be between 0 and 100',
    );
    expect(() => parseConfig(baseConfigText({ daemonIntervalMinutes: 0 }))).toThrow(
      'daemon.intervalMinutes must be > 0',
    );
  });

  test('rejects unsupported workflow knobs instead of silently ignoring them', () => {
    expect(() => parseConfig(baseConfigText({ extraWorkflowField: 'maxDiffLines' }))).toThrow(
      'unsupported fields: maxDiffLines',
    );
  });
});

function baseConfigText(
  options: {
    readonly daemonIntervalMinutes?: number;
    readonly extraWorkflowField?: string;
    readonly prompt?: string;
    readonly sessionReserveRemaining?: number;
  } = {},
): string {
  const extraWorkflowField =
    options.extraWorkflowField === undefined ? '' : `"${options.extraWorkflowField}": 10,`;
  return `{
    "daemon": { "intervalMinutes": ${options.daemonIntervalMinutes ?? 15}, "interruptPollSeconds": 30 },
    "activity": { "idleRequiredMinutes": 15, "interruptOnUserCodex": true },
    "quota": {
      "session": {
        "minRemainingToStart": 30,
        "reserveRemaining": ${options.sessionReserveRemaining ?? 15},
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
    "repos": [{
      "path": "./repo",
      "base": "main",
      "workflows": [{
        "id": "review",
        "type": "codex-skills",
        ${extraWorkflowField}
        "skills": ["./skills/review/SKILL.md"],
        "prompt": ${JSON.stringify(options.prompt ?? 'Review one bounded area.')}
      }]
    }]
  }`;
}
