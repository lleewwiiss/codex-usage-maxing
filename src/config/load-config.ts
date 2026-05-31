import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import {
  DEFAULT_CODEX_LAUNCH_CONFIG,
  DEFAULT_DAEMON_CONFIG,
  type CodexLaunchConfig,
  type CodexUsageMaxingConfig,
  type DaemonConfig,
  type QuotaWindowPolicy,
  type RepoConfig,
} from './default-config.js';
import type { WorkflowDefinition } from '../workflows/types.js';

export const CONFIG_FILE_NAME = 'codex-usage-maxing.config.jsonc';

export type ResolvedCodexUsageMaxingConfig = CodexUsageMaxingConfig & {
  readonly codex: Required<Pick<CodexLaunchConfig, 'askForApproval' | 'bin' | 'sandbox'>> &
    Omit<CodexLaunchConfig, 'askForApproval' | 'bin' | 'sandbox'>;
  readonly daemon: Required<DaemonConfig>;
  readonly repos: ReadonlyArray<ResolvedRepoConfig>;
};

export type ResolvedRepoConfig = Omit<RepoConfig, 'path'> & {
  readonly path: string;
};

export async function loadConfig(
  configPath = join(process.cwd(), CONFIG_FILE_NAME),
): Promise<ResolvedCodexUsageMaxingConfig> {
  const raw = await readFile(configPath, 'utf8');
  return parseConfig(raw, configPath);
}

export function parseConfig(
  raw: string,
  configPath = join(process.cwd(), CONFIG_FILE_NAME),
): ResolvedCodexUsageMaxingConfig {
  const value: unknown = JSON.parse(stripJsonc(raw));
  const config = parseConfigObject(value);
  const baseDirectory = dirname(configPath);

  return {
    ...config,
    codex: {
      askForApproval: config.codex?.askForApproval ?? DEFAULT_CODEX_LAUNCH_CONFIG.askForApproval,
      bin: config.codex?.bin ?? DEFAULT_CODEX_LAUNCH_CONFIG.bin,
      sandbox: config.codex?.sandbox ?? DEFAULT_CODEX_LAUNCH_CONFIG.sandbox,
      ...(config.codex?.extraArgs === undefined ? {} : { extraArgs: config.codex.extraArgs }),
      ...(config.codex?.model === undefined ? {} : { model: config.codex.model }),
    },
    daemon: {
      interruptPollSeconds:
        config.daemon?.interruptPollSeconds ?? DEFAULT_DAEMON_CONFIG.interruptPollSeconds,
      intervalMinutes: config.daemon?.intervalMinutes ?? DEFAULT_DAEMON_CONFIG.intervalMinutes,
    },
    repos: config.repos.map((repo) => ({ ...repo, path: resolvePath(repo.path, baseDirectory) })),
  };
}

function dirname(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? process.cwd() : path.slice(0, index);
}

function parseConfigObject(value: unknown): CodexUsageMaxingConfig {
  if (!isRecord(value)) {
    throw new Error('Config must be an object.');
  }

  const codex = parseCodex(value['codex']);
  const daemon = parseDaemon(value['daemon']);

  return {
    activity: parseActivity(value['activity']),
    ...optionalProperty('codex', codex),
    ...optionalProperty('daemon', daemon),
    quota: parseQuota(value['quota']),
    repos: parseRepos(value['repos']),
  };
}

function parseActivity(value: unknown): CodexUsageMaxingConfig['activity'] {
  if (!isRecord(value)) {
    throw new Error('Config activity must be an object.');
  }
  return {
    idleRequiredMinutes: parseNonNegativeNumber(
      value['idleRequiredMinutes'],
      'activity.idleRequiredMinutes',
    ),
    interruptOnUserCodex: parseBoolean(
      value['interruptOnUserCodex'],
      'activity.interruptOnUserCodex',
    ),
  };
}

function parseCodex(value: unknown): CodexLaunchConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Config codex must be an object.');
  }
  const askForApproval = parseOptionalEnum(value['askForApproval'], 'codex.askForApproval', [
    'never',
    'on-failure',
    'on-request',
    'untrusted',
  ]);
  const bin = parseOptionalString(value['bin'], 'codex.bin');
  const extraArgs = parseOptionalStringArray(value['extraArgs'], 'codex.extraArgs');
  const model = parseOptionalString(value['model'], 'codex.model');
  const sandbox = parseOptionalEnum(value['sandbox'], 'codex.sandbox', [
    'danger-full-access',
    'read-only',
    'workspace-write',
  ]);

  return {
    ...optionalProperty('askForApproval', askForApproval),
    ...optionalProperty('bin', bin),
    ...optionalProperty('extraArgs', extraArgs),
    ...optionalProperty('model', model),
    ...optionalProperty('sandbox', sandbox),
  };
}

function parseDaemon(value: unknown): DaemonConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Config daemon must be an object.');
  }
  const intervalMinutes = parseOptionalPositiveNumber(
    value['intervalMinutes'],
    'daemon.intervalMinutes',
  );
  const interruptPollSeconds = parseOptionalPositiveNumber(
    value['interruptPollSeconds'],
    'daemon.interruptPollSeconds',
  );

  return {
    ...optionalProperty('intervalMinutes', intervalMinutes),
    ...optionalProperty('interruptPollSeconds', interruptPollSeconds),
  };
}

function parseQuota(value: unknown): CodexUsageMaxingConfig['quota'] {
  if (!isRecord(value)) {
    throw new Error('Config quota must be an object.');
  }
  return {
    session: parseQuotaWindow(value['session'], 'quota.session'),
    weekly: parseQuotaWindow(value['weekly'], 'quota.weekly'),
  };
}

function parseQuotaWindow(value: unknown, field: string): QuotaWindowPolicy {
  if (!isRecord(value)) {
    throw new Error(`Config ${field} must be an object.`);
  }
  return {
    drainReserveRemaining: parsePercentage(
      value['drainReserveRemaining'],
      `${field}.drainReserveRemaining`,
    ),
    drainWhenResetWithinMinutes: parseNonNegativeNumber(
      value['drainWhenResetWithinMinutes'],
      `${field}.drainWhenResetWithinMinutes`,
    ),
    minRemainingToStart: parsePercentage(
      value['minRemainingToStart'],
      `${field}.minRemainingToStart`,
    ),
    reserveRemaining: parsePercentage(value['reserveRemaining'], `${field}.reserveRemaining`),
  };
}

function parseRepos(value: unknown): ReadonlyArray<RepoConfig> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Config repos must be a non-empty array.');
  }
  return value.map((repo, index) => parseRepo(repo, `repos[${index}]`));
}

function parseRepo(value: unknown, field: string): RepoConfig {
  if (!isRecord(value)) {
    throw new Error(`Config ${field} must be an object.`);
  }
  return {
    base: parseString(value['base'], `${field}.base`),
    path: parseString(value['path'], `${field}.path`),
    workflows: parseWorkflows(value['workflows'], `${field}.workflows`),
  };
}

function parseWorkflows(value: unknown, field: string): ReadonlyArray<WorkflowDefinition> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Config ${field} must be a non-empty array.`);
  }
  return value.map((workflow, index) => parseWorkflow(workflow, `${field}[${index}]`));
}

function parseWorkflow(value: unknown, field: string): WorkflowDefinition {
  if (!isRecord(value)) {
    throw new Error(`Config ${field} must be an object.`);
  }
  rejectUnsupportedFields(value, field, ['artifacts', 'maxDiffLines', 'maxRuntimeMinutes']);

  const validation = parseOptionalStringArray(value['validation'], `${field}.validation`);
  const base = {
    id: parseString(value['id'], `${field}.id`),
    ...optionalProperty('validation', validation),
  };

  switch (parseString(value['type'], `${field}.type`)) {
    case 'codex-skills':
      return {
        ...base,
        prompt: parseString(value['prompt'], `${field}.prompt`),
        skills: parseStringArray(value['skills'], `${field}.skills`),
        type: 'codex-skills',
      };
    case 'codex-prompt':
      return {
        ...base,
        promptFile: parseString(value['promptFile'], `${field}.promptFile`),
        type: 'codex-prompt',
      };
    case 'command':
      return {
        ...base,
        command: parseString(value['command'], `${field}.command`),
        type: 'command',
      };
    case 'findings-to-fix':
      return {
        ...base,
        findingsFile: parseString(value['findingsFile'], `${field}.findingsFile`),
        type: 'findings-to-fix',
      };
    default:
      throw new Error(`Config ${field}.type is unsupported.`);
  }
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Config ${field} must be a boolean.`);
  }
  return value;
}

function parseNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Config ${field} must be a finite number.`);
  }
  return value;
}

function parseNonNegativeNumber(value: unknown, field: string): number {
  const number = parseNumber(value, field);
  if (number < 0) {
    throw new Error(`Config ${field} must be >= 0.`);
  }
  return number;
}

function parsePercentage(value: unknown, field: string): number {
  const number = parseNumber(value, field);
  if (number < 0 || number > 100) {
    throw new Error(`Config ${field} must be between 0 and 100.`);
  }
  return number;
}

function parsePositiveNumber(value: unknown, field: string): number {
  const number = parseNumber(value, field);
  if (number <= 0) {
    throw new Error(`Config ${field} must be > 0.`);
  }
  return number;
}

function parseOptionalPositiveNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parsePositiveNumber(value, field);
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseString(value, field);
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Config ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function parseStringArray(value: unknown, field: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Config ${field} must be a non-empty string array.`);
  }
  return value.map((item, index) => parseString(item, `${field}[${index}]`));
}

function parseOptionalStringArray(
  value: unknown,
  field: string,
): ReadonlyArray<string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseStringArray(value, field);
}

function parseOptionalEnum<const Value extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlyArray<Value>,
): Value | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    throw new Error(`Config ${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as Value;
}

function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

function rejectUnsupportedFields(
  value: Record<string, unknown>,
  field: string,
  unsupported: ReadonlyArray<string>,
): void {
  const present = unsupported.filter((key) => key in value);
  if (present.length > 0) {
    throw new Error(`Config ${field} uses unsupported fields: ${present.join(', ')}.`);
  }
}

function resolvePath(path: string, baseDirectory: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : resolve(baseDirectory, path);
}

function stripJsonc(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (char === undefined) {
      break;
    }
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < input.length && input[index] !== '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return removeTrailingCommas(output);
}

function removeTrailingCommas(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === undefined) {
      break;
    }
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ',') {
      const nextIndex = nextNonWhitespaceIndex(input, index + 1);
      const next = nextIndex === null ? undefined : input[nextIndex];
      if (next === '}' || next === ']') {
        continue;
      }
    }
    output += char;
  }
  return output;
}

function nextNonWhitespaceIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (char === undefined) {
      return null;
    }
    if (!/\s/u.test(char)) {
      return index;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
