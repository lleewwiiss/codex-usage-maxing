import { describe, expect, test } from 'bun:test';

import {
  createManagedPrMarker,
  createWorkflowSlot,
  hashWorkflowConfig,
  parseManagedPrMarker,
  renderManagedPrInstructions,
  renderManagedPrMarker,
} from '../src/runner/idempotent-run.js';
import type { WorkflowDefinition } from '../src/workflows/types.js';

const workflow = {
  id: 'improve-tests',
  prompt: 'improve tests',
  skills: ['~/.agents/skills/improve-test-suite/SKILL.md'],
  type: 'codex-skills',
  validation: ['bun test'],
} satisfies WorkflowDefinition;

const target = {
  baseBranch: 'main',
  githubRepo: 'lleewwiiss/example',
  workflowId: 'improve-tests',
};

describe('createWorkflowSlot', () => {
  test('creates deterministic branch and worktree names from repo, base, and workflow id', () => {
    const slot = createWorkflowSlot(target);

    expect(slot.slotKey).toBe('lleewwiiss/example|main|improve-tests');
    expect(slot.branchName).toMatch(/^codex-usage-maxing\/improve-tests\/[a-f0-9]{12}$/u);
    expect(slot.worktreeName).toContain('codex-usage-maxing-lleewwiiss-example');
  });
});

describe('managed PR markers', () => {
  test('round-trips the ownership marker from a PR body', () => {
    const slot = createWorkflowSlot(target);
    const marker = createManagedPrMarker({
      configHash: hashWorkflowConfig(workflow),
      createdBaseSha: 'base-one',
      lastManagedHeadSha: 'head-one',
      slot,
    });

    expect(parseManagedPrMarker(`summary\n\n${renderManagedPrMarker(marker)}`)).toEqual(marker);
  });

  test('returns null for missing, malformed, duplicate, or internally inconsistent markers', () => {
    const slot = createWorkflowSlot(target);
    const marker = createManagedPrMarker({
      configHash: hashWorkflowConfig(workflow),
      createdBaseSha: 'base-one',
      lastManagedHeadSha: 'head-one',
      slot,
    });
    const rendered = renderManagedPrMarker(marker);

    expect(parseManagedPrMarker('ordinary PR body')).toBeNull();
    expect(parseManagedPrMarker('<!-- codex-usage-maxing: nope -->')).toBeNull();
    expect(parseManagedPrMarker(`${rendered}\n${rendered}`)).toBeNull();
    expect(
      parseManagedPrMarker(renderManagedPrMarker({ ...marker, workflowId: 'other' })),
    ).toBeNull();
    expect(
      parseManagedPrMarker(renderManagedPrMarker({ ...marker, githubRepo: '   ' })),
    ).toBeNull();
  });

  test('renders exact instructions for the launched Codex agent', () => {
    const slot = createWorkflowSlot(target);
    const instructions = renderManagedPrInstructions({
      configHash: hashWorkflowConfig(workflow),
      slot,
    });

    expect(instructions).toContain('Add label `codex-usage-maxing`');
    expect(instructions).toContain('"schema": 1');
    expect(instructions).toContain('"lastManagedHeadSha"');
    expect(instructions).toContain('"lastSyncedBaseSha"');
  });
});
