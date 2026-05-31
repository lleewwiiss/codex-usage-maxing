import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type AutomationDecisionStatus = 'blocked' | 'run' | 'skip';

export type AutomationDecision = {
  readonly baseBranch: string;
  readonly branchName: string;
  readonly checkedAt: string;
  readonly codexPid?: number;
  readonly githubRepo: string;
  readonly logPath?: string;
  readonly nextCheckAt?: string;
  readonly reason: string;
  readonly repoPath: string;
  readonly runId: string;
  readonly slotKey: string;
  readonly status: AutomationDecisionStatus;
  readonly workflowId: string;
  readonly worktreePath: string;
};

export type AutomationState = {
  readonly latest: AutomationDecision;
  readonly slots: Record<string, AutomationDecision | undefined>;
  readonly updatedAt: string;
  readonly version: 1;
};

export type StateOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly statePath?: string;
};

export function resolveStatePath(options: StateOptions = {}): string {
  const env = options.env ?? process.env;
  if (options.statePath !== undefined) {
    return options.statePath;
  }
  if (env['CODEX_USAGE_MAXING_STATE'] !== undefined) {
    return env['CODEX_USAGE_MAXING_STATE'];
  }
  if (env['XDG_STATE_HOME'] !== undefined) {
    return join(env['XDG_STATE_HOME'], 'codex-usage-maxing', 'state.json');
  }
  return join(homedir(), '.local', 'state', 'codex-usage-maxing', 'state.json');
}

export function createCodexLogPath(runId: string, options: StateOptions = {}): string {
  return join(dirname(resolveStatePath(options)), 'logs', `${safeFileName(runId)}.log`);
}

export async function readAutomationState(
  options: StateOptions = {},
): Promise<AutomationState | null> {
  const statePath = resolveStatePath(options);
  try {
    return parseAutomationState(JSON.parse(await readFile(statePath, 'utf8')));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function recordAutomationDecision(
  decision: AutomationDecision,
  options: StateOptions = {},
): Promise<void> {
  const statePath = resolveStatePath(options);
  const existing = await readAutomationState({ ...options, statePath });
  const updatedAt = new Date().toISOString();
  const state: AutomationState = {
    latest: decision,
    slots: { ...(existing?.slots ?? {}), [decision.slotKey]: decision },
    updatedAt,
    version: 1,
  };

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function formatAutomationState(state: AutomationState | null, statePath: string): string {
  if (state === null) {
    return `Automation state\nState file: ${statePath}\nLast decision: none yet\n`;
  }

  const latest = state.latest;
  const optionalLines = [
    latest.codexPid === undefined ? undefined : `Codex PID: ${latest.codexPid}`,
    latest.logPath === undefined ? undefined : `Log: ${latest.logPath}`,
    latest.nextCheckAt === undefined ? undefined : `Next check: ${latest.nextCheckAt}`,
  ].filter((line): line is string => line !== undefined);

  return `Automation state\nState file: ${statePath}\nLast decision: ${latest.status}\nReason: ${latest.reason}\nAt: ${latest.checkedAt}\nRepo: ${latest.githubRepo} (${latest.repoPath})\nWorkflow: ${latest.workflowId}\nSlot: ${latest.slotKey}\nBranch: ${latest.branchName}\nWorktree: ${latest.worktreePath}${optionalLines.length === 0 ? '' : `\n${optionalLines.join('\n')}`}\n`;
}

function parseAutomationState(value: unknown): AutomationState {
  if (!isRecord(value) || value['version'] !== 1 || !isRecord(value['slots'])) {
    throw new Error('Automation state file is invalid.');
  }

  const latest = parseDecision(value['latest']);
  const slots: Record<string, AutomationDecision | undefined> = {};
  for (const [slotKey, decision] of Object.entries(value['slots'])) {
    slots[slotKey] = parseDecision(decision);
  }

  return {
    latest,
    slots,
    updatedAt: parseString(value['updatedAt'], 'updatedAt'),
    version: 1,
  };
}

function parseDecision(value: unknown): AutomationDecision {
  if (!isRecord(value)) {
    throw new Error('Automation state decision is invalid.');
  }

  return {
    baseBranch: parseString(value['baseBranch'], 'baseBranch'),
    branchName: parseString(value['branchName'], 'branchName'),
    checkedAt: parseString(value['checkedAt'], 'checkedAt'),
    ...parseOptionalNumberField(value, 'codexPid'),
    githubRepo: parseString(value['githubRepo'], 'githubRepo'),
    ...parseOptionalStringField(value, 'logPath'),
    ...parseOptionalStringField(value, 'nextCheckAt'),
    reason: parseString(value['reason'], 'reason'),
    repoPath: parseString(value['repoPath'], 'repoPath'),
    runId: parseString(value['runId'], 'runId'),
    slotKey: parseString(value['slotKey'], 'slotKey'),
    status: parseStatus(value['status']),
    workflowId: parseString(value['workflowId'], 'workflowId'),
    worktreePath: parseString(value['worktreePath'], 'worktreePath'),
  };
}

function parseOptionalNumberField(
  value: Record<string, unknown>,
  field: 'codexPid',
): Partial<Pick<AutomationDecision, 'codexPid'>> {
  const fieldValue = value[field];
  if (fieldValue === undefined) {
    return {};
  }
  if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
    throw new Error(`Automation state ${field} is invalid.`);
  }
  return { [field]: fieldValue };
}

function parseOptionalStringField(
  value: Record<string, unknown>,
  field: 'logPath' | 'nextCheckAt',
): Pick<Partial<AutomationDecision>, typeof field> {
  const fieldValue = value[field];
  if (fieldValue === undefined) {
    return {};
  }
  return { [field]: parseString(fieldValue, field) };
}

function parseStatus(value: unknown): AutomationDecisionStatus {
  if (value === 'blocked' || value === 'run' || value === 'skip') {
    return value;
  }
  throw new Error('Automation state status is invalid.');
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Automation state ${field} is invalid.`);
  }
  return value;
}

function safeFileName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/gu, '-').replaceAll(/^-+|-+$/gu, '') || 'run';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
