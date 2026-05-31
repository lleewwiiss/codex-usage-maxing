import { describe, expect, test } from 'bun:test';

import { buildCodexJobPrompt } from '../src/orchestrator/prompt.js';

describe('buildCodexJobPrompt', () => {
  test('includes the exact managed PR marker contract', () => {
    const job = buildCodexJobPrompt({
      githubRepo: 'lleewwiiss/example',
      repo: {
        base: 'main',
        path: '/tmp/example',
        workflows: [],
      },
      runId: 'run-123',
      workflow: {
        id: 'improve-tests',
        prompt: 'Improve tests.',
        skills: ['~/.agents/skills/improve-test-suite/SKILL.md'],
        type: 'codex-skills',
      },
    });

    expect(job.prompt).toContain('Add label `codex-usage-maxing`');
    expect(job.prompt).toContain('<!-- codex-usage-maxing:');
    expect(job.prompt).toContain('"schema": 1');
    expect(job.prompt).toContain('"githubRepo": "lleewwiiss/example"');
    expect(job.prompt).toContain('"lastManagedHeadSha": "<head sha after your managed push>"');
    expect(job.prompt).toContain('"lastSyncedBaseSha": "<latest base sha after sync>"');
    expect(job.prompt).not.toContain('AI slop');
  });
});
