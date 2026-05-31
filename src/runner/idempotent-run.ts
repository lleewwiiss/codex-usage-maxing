import { createHash } from 'node:crypto';

import type { WorkflowDefinition } from '../workflows/types.js';

export const MANAGED_BRANCH_PREFIX = 'codex-usage-maxing';
export const MANAGED_LABEL = 'codex-usage-maxing';
export const DEFAULT_SLOT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const MARKER_PATTERN = /<!--\s*codex-usage-maxing:\s*([\s\S]*?)\s*-->/u;

export type WorkflowSlotIdentity = {
  readonly baseBranch: string;
  readonly githubRepo: string;
  readonly workflowId: string;
};

export type WorkflowRunTarget = WorkflowSlotIdentity & {
  readonly configHash: string;
};

export type WorkflowSlot = {
  readonly baseBranch: string;
  readonly branchName: string;
  readonly githubRepo: string;
  readonly slotKey: string;
  readonly workflowId: string;
  readonly worktreeName: string;
};

export type ManagedPrMarker = {
  readonly baseBranch: string;
  readonly configHash: string;
  readonly createdBaseSha: string;
  readonly githubRepo: string;
  readonly lastManagedHeadSha: string;
  readonly lastSyncedBaseSha: string;
  readonly schema: 1;
  readonly slotKey: string;
  readonly workflowId: string;
};

export type ManagedPullRequestStatus = 'closed' | 'merged' | 'open';

type ManagedPullRequestBase = {
  readonly body: string;
  readonly branchName: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly labels: ReadonlyArray<string>;
  readonly number: number;
};

export type ManagedPullRequestSnapshot =
  | (ManagedPullRequestBase & {
      readonly closedAtMs?: null;
      readonly status: 'open';
    })
  | (ManagedPullRequestBase & {
      readonly closedAtMs: number;
      readonly status: 'closed';
    })
  | (ManagedPullRequestBase & {
      readonly closedAtMs: number;
      readonly status: 'merged';
    });

export type ManagedWorktreeSnapshot =
  | {
      readonly exists: false;
    }
  | {
      readonly branchName: string;
      readonly clean: boolean;
      readonly exists: true;
    };

export type WorktreePlan = {
  readonly action: 'create' | 'reuse';
  readonly branchName: string;
  readonly name: string;
};

export type IdempotentRunStep =
  | 'checkout-managed-branch'
  | 'create-managed-branch'
  | 'ensure-managed-worktree'
  | 'fetch-base'
  | 'fetch-managed-branch'
  | 'push-existing-draft-pr'
  | 'push-new-draft-pr'
  | 'run-workflow'
  | 'sync-base'
  | 'validate';

export type IdempotentRunPlan =
  | {
      readonly action: 'freeze';
      readonly detail: string;
      readonly prNumber?: number;
      readonly reason:
        | 'ambiguous-managed-pr'
        | 'human-touched-pr'
        | 'local-worktree-dirty'
        | 'local-worktree-mismatch'
        | 'multiple-open-managed-prs';
      readonly slot: WorkflowSlot;
    }
  | {
      readonly action: 'resume-existing';
      readonly marker: ManagedPrMarker;
      readonly prBranchName: string;
      readonly prNumber: number;
      readonly reason: 'base-changed' | 'config-changed';
      readonly slot: WorkflowSlot;
      readonly steps: ReadonlyArray<IdempotentRunStep>;
      readonly worktree: WorktreePlan;
    }
  | {
      readonly action: 'skip';
      readonly prNumber?: number;
      readonly reason: 'slot-cooling-down' | 'slot-current';
      readonly slot: WorkflowSlot;
    }
  | {
      readonly action: 'start-new';
      readonly reason: 'no-managed-pr';
      readonly slot: WorkflowSlot;
      readonly steps: ReadonlyArray<IdempotentRunStep>;
      readonly worktree: WorktreePlan;
    };

export type PlanIdempotentRunInput = {
  readonly cooldownMs?: number;
  readonly currentBaseSha: string;
  readonly nowMs: number;
  readonly pullRequests: ReadonlyArray<ManagedPullRequestSnapshot>;
  readonly target: WorkflowRunTarget;
  readonly worktree: ManagedWorktreeSnapshot;
};

type ParsedPullRequest = {
  readonly marker: ManagedPrMarker | null;
  readonly pr: ManagedPullRequestSnapshot;
};

export function createWorkflowSlot(target: WorkflowSlotIdentity): WorkflowSlot {
  const githubRepo = normalizeGithubRepo(target.githubRepo);
  const baseBranch = requireNonEmpty(target.baseBranch, 'baseBranch');
  const workflowId = requireNonEmpty(target.workflowId, 'workflowId');
  const slotKey = `${githubRepo}|${baseBranch}|${workflowId}`;
  const slotHash = shortHash(slotKey);
  const workflowSlug = slug(workflowId);

  return {
    baseBranch,
    branchName: `${MANAGED_BRANCH_PREFIX}/${workflowSlug}/${slotHash}`,
    githubRepo,
    slotKey,
    workflowId,
    worktreeName: `${MANAGED_BRANCH_PREFIX}-${slug(githubRepo)}-${workflowSlug}-${slotHash}`,
  };
}

export function createManagedPrMarker(input: {
  readonly configHash: string;
  readonly createdBaseSha: string;
  readonly lastManagedHeadSha: string;
  readonly lastSyncedBaseSha?: string;
  readonly slot: WorkflowSlot;
}): ManagedPrMarker {
  return {
    baseBranch: input.slot.baseBranch,
    configHash: requireNonEmpty(input.configHash, 'configHash'),
    createdBaseSha: requireNonEmpty(input.createdBaseSha, 'createdBaseSha'),
    githubRepo: input.slot.githubRepo,
    lastManagedHeadSha: requireNonEmpty(input.lastManagedHeadSha, 'lastManagedHeadSha'),
    lastSyncedBaseSha: requireNonEmpty(
      input.lastSyncedBaseSha ?? input.createdBaseSha,
      'lastSyncedBaseSha',
    ),
    schema: 1,
    slotKey: input.slot.slotKey,
    workflowId: input.slot.workflowId,
  };
}

export function hashWorkflowConfig(workflow: WorkflowDefinition): string {
  return `sha256:${hashText(stableStringify(workflow))}`;
}

export function parseManagedPrMarker(body: string): ManagedPrMarker | null {
  const matches = [...body.matchAll(new RegExp(MARKER_PATTERN, 'gu'))];
  if (matches.length !== 1) {
    return null;
  }

  const markerJson = matches[0]?.[1];
  if (markerJson === undefined) {
    return null;
  }

  try {
    return parseMarker(JSON.parse(markerJson));
  } catch {
    return null;
  }
}

export function planIdempotentRun(input: PlanIdempotentRunInput): IdempotentRunPlan {
  const slot = createWorkflowSlot(input.target);
  const worktree = planWorktree(slot, input.worktree);
  if (worktree.action === 'freeze') {
    return { ...worktree, slot };
  }

  const currentBaseSha = requireNonEmpty(input.currentBaseSha, 'currentBaseSha');
  const configHash = requireNonEmpty(input.target.configHash, 'configHash');
  const cooldownMs = requireFiniteNonNegative(
    input.cooldownMs ?? DEFAULT_SLOT_COOLDOWN_MS,
    'cooldownMs',
  );
  const nowMs = requireFiniteNonNegative(input.nowMs, 'nowMs');
  const parsedPullRequests = input.pullRequests.map(parsePullRequest);
  const ambiguous = parsedPullRequests.find(
    ({ marker, pr }) => marker === null && isAmbiguousSlotCollision(pr, slot),
  );
  if (ambiguous !== undefined) {
    return {
      action: 'freeze',
      detail: 'Managed-looking PR is missing a valid marker, so the runner cannot prove ownership.',
      prNumber: ambiguous.pr.number,
      reason: 'ambiguous-managed-pr',
      slot,
    };
  }

  const matchingOpenPullRequests = parsedPullRequests.filter(
    ({ marker, pr }) => pr.status === 'open' && matchesSlot(pr, marker, slot),
  );
  if (matchingOpenPullRequests.length > 1) {
    return {
      action: 'freeze',
      detail: 'Multiple open managed PRs match the same workflow slot.',
      reason: 'multiple-open-managed-prs',
      slot,
    };
  }

  const matchingOpenPullRequest = matchingOpenPullRequests[0];
  if (matchingOpenPullRequest !== undefined) {
    return planOpenPullRequest({
      configHash,
      currentBaseSha,
      parsedPullRequest: matchingOpenPullRequest,
      slot,
      worktree,
    });
  }

  const coolingPullRequest = findCoolingPullRequest({
    cooldownMs,
    nowMs,
    parsedPullRequests,
    slot,
  });
  if (coolingPullRequest !== undefined) {
    return {
      action: 'skip',
      prNumber: coolingPullRequest.pr.number,
      reason: 'slot-cooling-down',
      slot,
    };
  }

  return {
    action: 'start-new',
    reason: 'no-managed-pr',
    slot,
    steps: [
      'ensure-managed-worktree',
      'fetch-base',
      'create-managed-branch',
      'run-workflow',
      'validate',
      'push-new-draft-pr',
    ],
    worktree,
  };
}

export function renderManagedPrMarker(marker: ManagedPrMarker): string {
  return `<!-- codex-usage-maxing:\n${JSON.stringify(marker, null, 2)}\n-->`;
}

function findCoolingPullRequest(input: {
  readonly cooldownMs: number;
  readonly nowMs: number;
  readonly parsedPullRequests: ReadonlyArray<ParsedPullRequest>;
  readonly slot: WorkflowSlot;
}): ParsedPullRequest | undefined {
  return input.parsedPullRequests.find(({ marker, pr }) => {
    if (marker?.slotKey !== input.slot.slotKey || pr.status === 'open') {
      return false;
    }

    return !Number.isFinite(pr.closedAtMs) || input.nowMs - pr.closedAtMs < input.cooldownMs;
  });
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isAmbiguousSlotCollision(pr: ManagedPullRequestSnapshot, slot: WorkflowSlot): boolean {
  return pr.status === 'open' && pr.branchName === slot.branchName;
}

function isMachineOwned(
  pr: ManagedPullRequestSnapshot,
  marker: ManagedPrMarker,
  slot: WorkflowSlot,
): boolean {
  return (
    pr.draft &&
    pr.branchName === slot.branchName &&
    pr.headSha === marker.lastManagedHeadSha &&
    pr.labels.includes(MANAGED_LABEL)
  );
}

function matchesSlot(
  pr: ManagedPullRequestSnapshot,
  marker: ManagedPrMarker | null,
  slot: WorkflowSlot,
): boolean {
  return marker?.slotKey === slot.slotKey || pr.branchName === slot.branchName;
}

function normalizeGithubRepo(githubRepo: string): string {
  return requireNonEmpty(githubRepo, 'githubRepo').toLowerCase();
}

function parseMarker(value: unknown): ManagedPrMarker | null {
  if (!isRecord(value) || value['schema'] !== 1) {
    return null;
  }

  const marker = {
    baseBranch: parseString(value['baseBranch']),
    configHash: parseString(value['configHash']),
    createdBaseSha: parseString(value['createdBaseSha']),
    githubRepo: parseString(value['githubRepo']),
    lastManagedHeadSha: parseString(value['lastManagedHeadSha']),
    lastSyncedBaseSha: parseString(value['lastSyncedBaseSha']),
    schema: 1,
    slotKey: parseString(value['slotKey']),
    workflowId: parseString(value['workflowId']),
  } satisfies ManagedPrMarker;

  if (Object.values(marker).some((field) => typeof field === 'string' && field.length === 0)) {
    return null;
  }

  if (createWorkflowSlot(marker).slotKey !== marker.slotKey) {
    return null;
  }

  return marker;
}

function parsePullRequest(pr: ManagedPullRequestSnapshot): ParsedPullRequest {
  return { marker: parseManagedPrMarker(pr.body), pr };
}

function parseString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function planOpenPullRequest(input: {
  readonly configHash: string;
  readonly currentBaseSha: string;
  readonly parsedPullRequest: ParsedPullRequest;
  readonly slot: WorkflowSlot;
  readonly worktree: WorktreePlan;
}): IdempotentRunPlan {
  const { marker, pr } = input.parsedPullRequest;
  if (marker === null || marker.slotKey !== input.slot.slotKey) {
    return {
      action: 'freeze',
      detail: 'Open PR branch matches this slot but its marker does not.',
      prNumber: pr.number,
      reason: 'ambiguous-managed-pr',
      slot: input.slot,
    };
  }

  if (!isMachineOwned(pr, marker, input.slot)) {
    return {
      action: 'freeze',
      detail: 'Open managed PR is no longer a draft, label/branch changed, or head SHA changed.',
      prNumber: pr.number,
      reason: 'human-touched-pr',
      slot: input.slot,
    };
  }

  if (marker.configHash !== input.configHash) {
    return resumeExistingPlan(input, marker, pr.number, 'config-changed');
  }

  if (marker.lastSyncedBaseSha !== input.currentBaseSha) {
    return resumeExistingPlan(input, marker, pr.number, 'base-changed');
  }

  return { action: 'skip', prNumber: pr.number, reason: 'slot-current', slot: input.slot };
}

function planWorktree(
  slot: WorkflowSlot,
  worktree: ManagedWorktreeSnapshot,
):
  | WorktreePlan
  | {
      readonly action: 'freeze';
      readonly detail: string;
      readonly reason: 'local-worktree-dirty' | 'local-worktree-mismatch';
    } {
  if (!worktree.exists) {
    return { action: 'create', branchName: slot.branchName, name: slot.worktreeName };
  }

  if (worktree.branchName !== slot.branchName) {
    return {
      action: 'freeze',
      detail: 'Existing managed worktree is on a different branch than the workflow slot.',
      reason: 'local-worktree-mismatch',
    };
  }

  if (!worktree.clean) {
    return {
      action: 'freeze',
      detail: 'Existing managed worktree has uncommitted changes.',
      reason: 'local-worktree-dirty',
    };
  }

  return { action: 'reuse', branchName: slot.branchName, name: slot.worktreeName };
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Missing ${field}.`);
  }
  return trimmed;
}

function requireFiniteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

function resumeExistingPlan(
  input: {
    readonly slot: WorkflowSlot;
    readonly worktree: WorktreePlan;
  },
  marker: ManagedPrMarker,
  prNumber: number,
  reason: 'base-changed' | 'config-changed',
): IdempotentRunPlan {
  return {
    action: 'resume-existing',
    marker,
    prBranchName: input.slot.branchName,
    prNumber,
    reason,
    slot: input.slot,
    steps: [
      'ensure-managed-worktree',
      'fetch-managed-branch',
      'fetch-base',
      'checkout-managed-branch',
      'sync-base',
      'run-workflow',
      'validate',
      'push-existing-draft-pr',
    ],
    worktree: input.worktree,
  };
}

function shortHash(value: string): string {
  return hashText(value).slice(0, 12);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/gu, '-')
      .replaceAll(/^-+|-+$/gu, '')
      .slice(0, 48) || 'slot'
  );
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }

  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  return `{${Object.entries(value)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, fieldValue]) => `${JSON.stringify(key)}:${stableStringify(fieldValue)}`)
    .join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
