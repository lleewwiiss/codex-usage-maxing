import { describe, expect, test } from 'bun:test';

import {
  MANAGED_LABEL,
  createManagedPrMarker,
  createWorkflowSlot,
  hashWorkflowConfig,
  parseManagedPrMarker,
  planIdempotentRun,
  renderManagedPrMarker,
  type ManagedPullRequestSnapshot,
  type PlanIdempotentRunInput,
  type WorkflowRunTarget,
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
  configHash: hashWorkflowConfig(workflow),
  githubRepo: 'lleewwiiss/example',
  workflowId: 'improve-tests',
} satisfies WorkflowRunTarget;

describe('createWorkflowSlot', () => {
  test('creates deterministic branch and worktree names from repo, base, and workflow id', () => {
    const slot = createWorkflowSlot(target);
    const changedConfigTarget = {
      ...target,
      configHash: hashWorkflowConfig({ ...workflow, prompt: 'changed prompt' }),
    } satisfies WorkflowRunTarget;
    const sameSlotWithDifferentConfig = createWorkflowSlot(changedConfigTarget);

    expect(sameSlotWithDifferentConfig).toEqual(slot);
    expect(slot.slotKey).toBe('lleewwiiss/example|main|improve-tests');
    expect(slot.branchName).toMatch(/^codex-usage-maxing\/improve-tests\/[a-f0-9]{12}$/u);
    expect(slot.worktreeName).toContain('codex-usage-maxing-lleewwiiss-example');
  });
});

describe('managed PR markers', () => {
  test('round-trips the ownership marker from a PR body', () => {
    const slot = createWorkflowSlot(target);
    const marker = createManagedPrMarker({
      configHash: target.configHash,
      createdBaseSha: 'base-one',
      lastManagedHeadSha: 'head-one',
      slot,
    });

    expect(parseManagedPrMarker(`summary\n\n${renderManagedPrMarker(marker)}`)).toEqual(marker);
  });

  test('returns null for missing or malformed markers', () => {
    expect(parseManagedPrMarker('ordinary PR body')).toBeNull();
    expect(parseManagedPrMarker('<!-- codex-usage-maxing: nope -->')).toBeNull();
  });

  test('returns null for duplicate or internally inconsistent markers', () => {
    const slot = createWorkflowSlot(target);
    const marker = createManagedPrMarker({
      configHash: target.configHash,
      createdBaseSha: 'base-one',
      lastManagedHeadSha: 'head-one',
      slot,
    });
    const rendered = renderManagedPrMarker(marker);

    expect(parseManagedPrMarker(`${rendered}\n${rendered}`)).toBeNull();
    expect(
      parseManagedPrMarker(renderManagedPrMarker({ ...marker, workflowId: 'other' })),
    ).toBeNull();
    expect(
      parseManagedPrMarker(renderManagedPrMarker({ ...marker, githubRepo: '   ' })),
    ).toBeNull();
  });
});

describe('planIdempotentRun', () => {
  test('starts a new managed branch when the slot has no PR', () => {
    const plan = planRun({
      currentBaseSha: 'base-one',
      pullRequests: [],
    });

    expect(plan).toMatchObject({
      action: 'start-new',
      reason: 'no-managed-pr',
      worktree: { action: 'create', branchName: createWorkflowSlot(target).branchName },
    });
    expect(plan.action === 'start-new' ? plan.steps : []).toEqual([
      'ensure-managed-worktree',
      'fetch-base',
      'create-managed-branch',
      'run-workflow',
      'validate',
      'push-new-draft-pr',
    ]);
  });

  test('skips an already-current slot instead of spending quota again', () => {
    const pullRequest = managedPullRequest({
      baseSha: 'base-one',
      configHash: target.configHash,
      headSha: 'head-one',
    });

    expect(
      planRun({
        currentBaseSha: 'base-one',
        pullRequests: [pullRequest],
      }),
    ).toMatchObject({ action: 'skip', prNumber: 12, reason: 'slot-current' });
  });

  test('resumes the same draft PR when the base branch changed', () => {
    const pullRequest = managedPullRequest({
      baseSha: 'base-one',
      configHash: target.configHash,
      headSha: 'head-one',
    });
    const plan = planRun({
      currentBaseSha: 'base-two',
      pullRequests: [pullRequest],
      worktree: { branchName: createWorkflowSlot(target).branchName, clean: true, exists: true },
    });

    expect(plan).toMatchObject({
      action: 'resume-existing',
      prBranchName: createWorkflowSlot(target).branchName,
      prNumber: 12,
      reason: 'base-changed',
      worktree: { action: 'reuse', branchName: createWorkflowSlot(target).branchName },
    });
    expect(plan.action === 'resume-existing' ? plan.steps : []).toContain('fetch-managed-branch');
    expect(plan.action === 'resume-existing' ? plan.steps.at(-1) : undefined).toBe(
      'push-existing-draft-pr',
    );
  });

  test('fetches the existing PR branch before recreating a missing stale worktree', () => {
    const pullRequest = managedPullRequest({
      baseSha: 'base-one',
      configHash: target.configHash,
      headSha: 'head-one',
    });
    const plan = planRun({ currentBaseSha: 'base-two', pullRequests: [pullRequest] });

    expect(plan).toMatchObject({
      action: 'resume-existing',
      worktree: { action: 'create', branchName: createWorkflowSlot(target).branchName },
    });
    expect(plan.action === 'resume-existing' ? plan.steps.slice(0, 3) : []).toEqual([
      'ensure-managed-worktree',
      'fetch-managed-branch',
      'fetch-base',
    ]);
  });

  test('resumes the same draft PR when the workflow config changed', () => {
    const pullRequest = managedPullRequest({
      baseSha: 'base-one',
      configHash: hashWorkflowConfig({ ...workflow, prompt: 'old prompt' }),
      headSha: 'head-one',
    });

    expect(planRun({ currentBaseSha: 'base-one', pullRequests: [pullRequest] })).toMatchObject({
      action: 'resume-existing',
      prNumber: 12,
      reason: 'config-changed',
    });
  });

  test('freezes instead of overwriting a human-touched PR', () => {
    const pullRequest = managedPullRequest({
      baseSha: 'base-one',
      configHash: target.configHash,
      headSha: 'head-one',
    });

    expect(
      planRun({
        currentBaseSha: 'base-two',
        pullRequests: [{ ...pullRequest, headSha: 'human-head' }],
      }),
    ).toMatchObject({ action: 'freeze', prNumber: 12, reason: 'human-touched-pr' });
  });

  test('freezes instead of adopting a matching marker on the wrong branch', () => {
    const pullRequest = managedPullRequest({
      baseSha: 'base-one',
      configHash: target.configHash,
      headSha: 'head-one',
    });

    expect(
      planRun({
        currentBaseSha: 'base-two',
        pullRequests: [{ ...pullRequest, branchName: 'codex-usage-maxing/improve-tests/manual' }],
      }),
    ).toMatchObject({ action: 'freeze', prNumber: 12, reason: 'human-touched-pr' });
  });

  test('freezes on markerless exact branch collisions', () => {
    expect(
      planRun({
        currentBaseSha: 'base-one',
        pullRequests: [
          {
            ...managedPullRequest({
              baseSha: 'base-one',
              configHash: target.configHash,
              headSha: 'head-one',
            }),
            body: '',
          },
        ],
      }),
    ).toMatchObject({ action: 'freeze', prNumber: 12, reason: 'ambiguous-managed-pr' });
  });

  test('freezes when multiple open PRs match the same slot', () => {
    const firstPullRequest = managedPullRequest({
      baseSha: 'base-one',
      configHash: target.configHash,
      headSha: 'head-one',
    });
    const secondPullRequest = { ...firstPullRequest, headSha: 'head-two', number: 13 };

    expect(
      planRun({ currentBaseSha: 'base-two', pullRequests: [firstPullRequest, secondPullRequest] }),
    ).toMatchObject({ action: 'freeze', reason: 'multiple-open-managed-prs' });
  });

  test('keeps a closed slot cooling down', () => {
    const pullRequest = managedPullRequest({
      baseSha: 'base-one',
      configHash: target.configHash,
      headSha: 'head-one',
      status: 'merged',
    });

    expect(
      planRun({
        currentBaseSha: 'base-two',
        pullRequests: [pullRequest],
      }),
    ).toMatchObject({ action: 'skip', prNumber: 12, reason: 'slot-cooling-down' });
  });

  test('starts new work after a closed slot cooldown expires', () => {
    const pullRequest = closedPullRequest({
      baseSha: 'base-one',
      configHash: target.configHash,
      headSha: 'head-one',
    });

    expect(
      planRun({
        cooldownMs: 100,
        currentBaseSha: 'base-two',
        nowMs: 10_000,
        pullRequests: [{ ...pullRequest, closedAtMs: 9800 }],
      }),
    ).toMatchObject({ action: 'start-new', reason: 'no-managed-pr' });
  });

  test('treats zero cooldown as expired at the boundary', () => {
    const pullRequest = closedPullRequest({
      baseSha: 'base-one',
      configHash: target.configHash,
      headSha: 'head-one',
    });

    expect(
      planRun({ cooldownMs: 0, pullRequests: [{ ...pullRequest, closedAtMs: 10_000 }] }),
    ).toMatchObject({ action: 'start-new', reason: 'no-managed-pr' });
  });

  test('freezes on dirty managed worktrees', () => {
    expect(
      planRun({
        currentBaseSha: 'base-one',
        pullRequests: [],
        worktree: { branchName: createWorkflowSlot(target).branchName, clean: false, exists: true },
      }),
    ).toMatchObject({ action: 'freeze', reason: 'local-worktree-dirty' });
  });
});

function planRun(overrides: Partial<PlanIdempotentRunInput>) {
  return planIdempotentRun({
    currentBaseSha: 'base-one',
    nowMs: 10_000,
    pullRequests: [],
    target,
    worktree: { exists: false },
    ...overrides,
  });
}

function managedPullRequest(input: {
  readonly baseSha: string;
  readonly configHash: string;
  readonly headSha: string;
  readonly status?: ManagedPullRequestSnapshot['status'];
}): ManagedPullRequestSnapshot {
  const slot = createWorkflowSlot(target);
  const marker = createManagedPrMarker({
    configHash: input.configHash,
    createdBaseSha: input.baseSha,
    lastManagedHeadSha: input.headSha,
    slot,
  });

  const base = {
    body: renderManagedPrMarker(marker),
    branchName: slot.branchName,
    draft: true,
    headSha: input.headSha,
    labels: [MANAGED_LABEL],
    number: 12,
  };

  if (input.status === 'closed' || input.status === 'merged') {
    return { ...base, closedAtMs: 9500, status: input.status };
  }

  return { ...base, closedAtMs: null, status: 'open' };
}

function closedPullRequest(input: {
  readonly baseSha: string;
  readonly configHash: string;
  readonly headSha: string;
}): Extract<ManagedPullRequestSnapshot, { readonly status: 'closed' }> {
  const pullRequest = managedPullRequest({ ...input, status: 'closed' });
  if (pullRequest.status !== 'closed') {
    throw new Error('Expected a closed pull request fixture.');
  }
  return pullRequest;
}
