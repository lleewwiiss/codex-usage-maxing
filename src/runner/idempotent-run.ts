import { createHash } from 'node:crypto';

import type { WorkflowDefinition } from '../workflows/types.js';

export const MANAGED_BRANCH_PREFIX = 'codex-usage-maxing';
export const MANAGED_LABEL = 'codex-usage-maxing';

const MARKER_PATTERN = /<!--\s*codex-usage-maxing:\s*([\s\S]*?)\s*-->/u;

export type WorkflowSlotIdentity = {
  readonly baseBranch: string;
  readonly githubRepo: string;
  readonly workflowId: string;
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

export function renderManagedPrInstructions(input: {
  readonly configHash: string;
  readonly slot: WorkflowSlot;
}): string {
  const marker = {
    baseBranch: input.slot.baseBranch,
    configHash: input.configHash,
    createdBaseSha: '<base sha when managed branch was created>',
    githubRepo: input.slot.githubRepo,
    lastManagedHeadSha: '<head sha after your managed push>',
    lastSyncedBaseSha: '<latest base sha after sync>',
    schema: 1,
    slotKey: input.slot.slotKey,
    workflowId: input.slot.workflowId,
  } satisfies ManagedPrMarker;

  return `Add label \`${MANAGED_LABEL}\` to the draft PR. Include exactly one hidden ownership marker in the PR body with this JSON shape, replacing angle-bracket placeholders with real SHAs after syncing and pushing:\n${renderManagedPrMarker(marker)}`;
}

export function renderManagedPrMarker(marker: ManagedPrMarker): string {
  return `<!-- codex-usage-maxing:\n${JSON.stringify(marker, null, 2)}\n-->`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

function parseString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Missing ${field}.`);
  }
  return trimmed;
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
