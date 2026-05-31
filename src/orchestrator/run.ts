import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { finished } from 'node:stream/promises';

import {
  normalizeCodexActivity,
  readCodexActivity,
  type CodexActivitySnapshot,
  type CodexActiveThreadSummary,
} from '../codex/activity.js';
import { formatActivity } from '../codex/format-activity.js';
import { formatQuota } from '../codex/format-quota.js';
import { readCodexQuota, type CodexQuotaSnapshot } from '../codex/quota.js';
import type { ResolvedCodexUsageMaxingConfig, ResolvedRepoConfig } from '../config/load-config.js';
import type { WorkflowDefinition } from '../workflows/types.js';
import { readGithubRepo } from './github-repo.js';
import { buildCodexJobPrompt, type CodexJobPrompt } from './prompt.js';
import { decideQuota } from './quota-policy.js';
import {
  createCodexLogPath,
  recordAutomationDecision,
  type AutomationDecisionStatus,
} from './state.js';

export type RunOptions = {
  readonly dryRun: boolean;
  readonly repo?: string;
  readonly workflow?: string;
};

export type RunResult = {
  readonly reason: string;
  readonly status: AutomationDecisionStatus;
};

type SelectedJob = {
  readonly githubRepo: string;
  readonly prompt: CodexJobPrompt;
  readonly repo: ResolvedRepoConfig;
  readonly runId: string;
  readonly workflow: WorkflowDefinition;
};

type ChildExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};

type DecisionExtras = {
  readonly codexPid?: number;
  readonly logPath?: string;
};

type ActivityDecision = {
  readonly allowed: boolean;
  readonly reason: string;
};

export async function runOnce(
  config: ResolvedCodexUsageMaxingConfig,
  options: RunOptions,
): Promise<RunResult> {
  const job = await selectJob(config, options);
  let quota: CodexQuotaSnapshot;
  try {
    quota = await readCodexQuota({ codexBin: config.codex.bin });
  } catch (error) {
    await maybeRecordJobDecision(
      config,
      options,
      job,
      'blocked',
      `quota read failed: ${formatError(error)}`,
    );
    throw error;
  }

  let activity: CodexActivitySnapshot;
  try {
    activity = await readCodexActivity({ codexBin: config.codex.bin });
  } catch (error) {
    await maybeRecordJobDecision(
      config,
      options,
      job,
      'blocked',
      `activity read failed: ${formatError(error)}`,
    );
    throw error;
  }

  if (options.dryRun) {
    process.stdout.write('codex-usage-maxing dry run\n\n');
    process.stdout.write(formatQuota(quota));
    process.stdout.write('\n');
    process.stdout.write(formatActivity(activity));
    process.stdout.write('\n');
  }

  const quotaDecision = decideQuota(config, quota);
  if (!quotaDecision.allowed) {
    process.stdout.write(`Decision: skip\nReason: ${quotaDecision.reason}\n`);
    await maybeRecordJobDecision(config, options, job, 'skip', quotaDecision.reason);
    return { reason: quotaDecision.reason, status: 'skip' };
  }

  const activityDecision = decideActivity(config, activity);
  if (!activityDecision.allowed) {
    const reason = activityDecision.reason;
    process.stdout.write(`Decision: skip\nReason: ${reason}\n`);
    await maybeRecordJobDecision(config, options, job, 'skip', reason);
    return { reason, status: 'skip' };
  }

  const command = buildCodexCommand(config, job);

  if (options.dryRun) {
    printDryRun(job, command);
    return { reason: 'dry run only', status: 'skip' };
  }

  return launchCodexJob(config, job, command);
}

export async function runDaemon(
  config: ResolvedCodexUsageMaxingConfig,
  options: Omit<RunOptions, 'dryRun'>,
): Promise<void> {
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (): void => {
    stopping = true;
    wake?.();
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(
    `codex-usage-maxing daemon started; interval ${config.daemon.intervalMinutes}m\n`,
  );

  try {
    while (!stopping) {
      try {
        const result = await runOnce(config, { ...options, dryRun: false });
        process.stdout.write(`Daemon decision: ${result.status} — ${result.reason}\n`);
      } catch (error) {
        process.stderr.write(`Daemon run failed: ${formatError(error)}\n`);
      }

      if (!stopping) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, config.daemon.intervalMinutes * 60_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.stdout.write('codex-usage-maxing daemon stopped\n');
  }
}

function buildCodexCommand(
  config: ResolvedCodexUsageMaxingConfig,
  job: SelectedJob,
): readonly [string, ...Array<string>] {
  return [
    config.codex.bin,
    'exec',
    '-C',
    job.repo.path,
    '--add-dir',
    dirname(job.prompt.worktreePath),
    '--sandbox',
    config.codex.sandbox,
    '--ask-for-approval',
    config.codex.askForApproval,
    ...(config.codex.model === undefined ? [] : ['--model', config.codex.model]),
    ...(config.codex.extraArgs ?? []),
    '-',
  ];
}

function decideActivity(
  config: ResolvedCodexUsageMaxingConfig,
  activity: CodexActivitySnapshot,
  nowMs = Date.now(),
): ActivityDecision {
  if (!config.activity.interruptOnUserCodex) {
    return { allowed: true, reason: 'activity policy allows a run' };
  }
  if (activity.isUserActive) {
    return { allowed: false, reason: 'user Codex activity detected' };
  }

  const latestActivityMs = normalizeTimestampMs(activity.latestNonOwnedThreadUpdatedAt);
  if (latestActivityMs === null) {
    return { allowed: true, reason: 'no recent Codex activity found' };
  }

  const idleMs = nowMs - latestActivityMs;
  const requiredIdleMs = config.activity.idleRequiredMinutes * 60_000;
  if (idleMs < requiredIdleMs) {
    return {
      allowed: false,
      reason: `waiting for ${config.activity.idleRequiredMinutes}m Codex idle window`,
    };
  }

  return { allowed: true, reason: 'Codex idle window satisfied' };
}

async function launchCodexJob(
  config: ResolvedCodexUsageMaxingConfig,
  job: SelectedJob,
  command: readonly [string, ...Array<string>],
): Promise<RunResult> {
  const [bin, ...args] = command;

  const logPath = createCodexLogPath(job.runId);
  await mkdir(dirname(logPath), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: 'a' });
  logStream.on('error', (error) => {
    process.stderr.write(`Codex log write failed: ${error.message}\n`);
  });
  logStream.write(`\n=== ${new Date().toISOString()} ${job.runId} ===\n`);

  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    logStream.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    logStream.write(chunk);
  });
  child.stdin.end(job.prompt.prompt);

  try {
    await recordJobDecision(config, job, 'run', 'Codex launched', {
      ...(child.pid === undefined ? {} : { codexPid: child.pid }),
      logPath,
    });
  } catch (error) {
    child.kill('SIGTERM');
    logStream.end();
    await finished(logStream);
    throw error;
  }

  const ownedThreadIds = new Set<string>();
  let stopReason: string | undefined;
  let stopStatus: AutomationDecisionStatus | undefined;
  const pollMs = config.daemon.interruptPollSeconds * 1000;
  const monitor = setInterval(() => {
    void monitorCodexActivity(config, job, ownedThreadIds).then((activityDecision) => {
      if (activityDecision === null) {
        return;
      }
      stopReason = activityDecision.reason;
      stopStatus = activityDecision.status;
      child.kill('SIGTERM');
    });
  }, pollMs);

  let exit: ChildExit;
  try {
    exit = await new Promise<ChildExit>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    clearInterval(monitor);
    const reason = `Codex launch failed: ${formatError(error)}`;
    await recordJobDecision(config, job, 'blocked', reason, { logPath });
    logStream.end();
    await finished(logStream);
    throw error;
  }

  clearInterval(monitor);
  logStream.end();
  await finished(logStream);

  if (stopStatus !== undefined && stopReason !== undefined) {
    await recordJobDecision(config, job, stopStatus, stopReason, { logPath });
    return { reason: stopReason, status: stopStatus };
  }

  if (exit.code === 0) {
    const reason = 'Codex completed';
    await recordJobDecision(config, job, 'run', reason, { logPath });
    return { reason, status: 'run' };
  }

  const status = stopStatus ?? 'blocked';
  const reason = stopReason ?? `Codex exited with code=${exit.code} signal=${exit.signal}`;
  await recordJobDecision(config, job, status, reason, { logPath });
  return { reason, status };
}

function normalizeTimestampMs(timestamp: number | null): number | null {
  if (timestamp === null) {
    return null;
  }
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function printDryRun(job: SelectedJob, command: ReadonlyArray<string>): void {
  process.stdout.write(`Selected job
  repo: ${job.repo.path}
  base: ${job.repo.base}
  workflow: ${job.workflow.id}
  slot: ${job.prompt.slotKey}
  branch: ${job.prompt.branchName}
  worktree: ${job.prompt.worktreePath}

Codex command
  ${command.map(shellQuote).join(' ')}

Prompt preview
${indent(job.prompt.prompt)}

No Codex session launched.
No repo files changed.
Automation state unchanged.
`);
}

async function monitorCodexActivity(
  config: ResolvedCodexUsageMaxingConfig,
  job: SelectedJob,
  ownedThreadIds: Set<string>,
): Promise<{ readonly reason: string; readonly status: AutomationDecisionStatus } | null> {
  try {
    const snapshot = await readCodexActivity({
      codexBin: config.codex.bin,
      ownedThreadIds: [...ownedThreadIds],
    });

    const ownedCandidates = snapshot.activeThreads.filter((thread) =>
      isOwnedThreadCandidate(thread, job),
    );
    if (ownedCandidates.length === 1) {
      const threadId = ownedCandidates[0]?.threadId;
      if (threadId !== undefined) {
        ownedThreadIds.add(threadId);
      }
    }

    const activity = normalizeCodexActivity(snapshot.activeThreads, {
      ownedThreadIds: [...ownedThreadIds],
    });
    if (activity.isUserActive && config.activity.interruptOnUserCodex) {
      return { reason: 'interrupted by user Codex activity', status: 'skip' };
    }
  } catch (error) {
    return { reason: `activity monitor failed closed: ${formatError(error)}`, status: 'blocked' };
  }
  return null;
}

async function maybeRecordJobDecision(
  config: ResolvedCodexUsageMaxingConfig,
  options: RunOptions,
  job: SelectedJob,
  status: AutomationDecisionStatus,
  reason: string,
  extras: DecisionExtras = {},
): Promise<void> {
  if (options.dryRun) {
    return;
  }
  await recordJobDecision(config, job, status, reason, extras);
}

async function recordJobDecision(
  config: ResolvedCodexUsageMaxingConfig,
  job: SelectedJob,
  status: AutomationDecisionStatus,
  reason: string,
  extras: DecisionExtras = {},
): Promise<void> {
  await recordAutomationDecision({
    baseBranch: job.repo.base,
    branchName: job.prompt.branchName,
    checkedAt: new Date().toISOString(),
    ...optionalNumber('codexPid', extras.codexPid),
    githubRepo: job.githubRepo,
    ...optionalString('logPath', extras.logPath),
    nextCheckAt: new Date(Date.now() + config.daemon.intervalMinutes * 60_000).toISOString(),
    reason,
    repoPath: job.repo.path,
    runId: job.runId,
    slotKey: job.prompt.slotKey,
    status,
    workflowId: job.workflow.id,
    worktreePath: job.prompt.worktreePath,
  });
}

async function selectJob(
  config: ResolvedCodexUsageMaxingConfig,
  options: RunOptions,
): Promise<SelectedJob> {
  const repo = config.repos.find((candidate) => {
    if (options.repo === undefined) {
      return true;
    }
    return candidate.path === options.repo || candidate.path.endsWith(options.repo);
  });
  if (repo === undefined) {
    throw new Error('No configured repo matched this run.');
  }

  const workflow = repo.workflows.find((candidate) => {
    if (options.workflow === undefined) {
      return true;
    }
    return candidate.id === options.workflow;
  });
  if (workflow === undefined) {
    throw new Error(`No workflow matched repo ${repo.path}.`);
  }

  const githubRepo = await readGithubRepo(repo.path);
  const runId = `codex-usage-maxing:${Date.now().toString(36)}:${workflow.id}`;
  return {
    githubRepo,
    prompt: buildCodexJobPrompt({ githubRepo, repo, runId, workflow }),
    repo,
    runId,
    workflow,
  };
}

function formatError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

function indent(value: string): string {
  return value
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function isOwnedThreadCandidate(thread: CodexActiveThreadSummary, job: SelectedJob): boolean {
  return (
    thread.cwd === job.repo.path &&
    (thread.preview.includes(job.runId) || thread.name?.includes(job.runId) === true)
  );
}

function optionalNumber<Key extends string>(
  key: Key,
  value: number | undefined,
): Record<Key, number> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, number>);
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): Record<Key, string> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, string>);
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=@-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
