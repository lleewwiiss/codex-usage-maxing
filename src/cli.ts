#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { formatActivity } from './codex/format-activity.js';
import { formatQuota } from './codex/format-quota.js';
import { readCodexActivity } from './codex/activity.js';
import { readCodexQuota } from './codex/quota.js';
import { defaultConfigText } from './config/default-config.js';
import { CONFIG_FILE_NAME, loadConfig } from './config/load-config.js';
import { runDaemon, runOnce, type RunOptions } from './orchestrator/run.js';
import {
  formatAutomationState,
  readAutomationState,
  resolveStatePath,
} from './orchestrator/state.js';

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const command = argv[2] ?? 'help';

  switch (command) {
    case 'activity': {
      const activity = await readCodexActivity();
      process.stdout.write(formatActivity(activity));
      return;
    }
    case 'help': {
      writeHelp();
      return;
    }
    case 'init': {
      await initConfig();
      return;
    }
    case 'run': {
      const options = parseRunArgs(argv.slice(3));
      const config = await loadConfig(options.configPath);
      const result = await runOnce(config, toRunOptions(options));
      if (result.status === 'blocked') {
        process.exitCode = 1;
      }
      return;
    }
    case 'daemon': {
      const options = parseRunArgs(argv.slice(3));
      const config = await loadConfig(options.configPath);
      await runDaemon(config, toDaemonOptions(options));
      return;
    }
    case 'runs': {
      await writeAutomationState();
      return;
    }
    case 'status': {
      const quota = await readCodexQuota();
      process.stdout.write(formatQuota(quota));
      process.stdout.write('\n');
      await writeAutomationState();
      return;
    }
    default: {
      throw new Error(`Unknown command: ${command}`);
    }
  }
}

function writeHelp(): void {
  process.stdout.write(`codex-usage-maxing

Commands:
  activity  Read local Codex thread activity for user-preemption
  daemon    Run forever, launching Codex when quota and activity allow it
  init      Write ${CONFIG_FILE_NAME} in the current directory
  run       Run one scheduler pass; use --dry-run to preview
  runs      Show last automation run/skip/blocked decision
  status    Read native Codex 5h session + weekly quota, then run state
  help      Show this help

Run options:
  --config <path>    Config path (default: ./${CONFIG_FILE_NAME})
  --repo <path>      Restrict to a configured repo path suffix
  --workflow <id>    Restrict to a configured workflow id
  --dry-run          Print the selected Codex job without launching it
`);
}

async function initConfig(): Promise<void> {
  const configPath = join(process.cwd(), CONFIG_FILE_NAME);
  await writeFile(configPath, defaultConfigText, { flag: 'wx' });
  process.stdout.write(`Wrote ${configPath}\n`);
}

async function writeAutomationState(): Promise<void> {
  const statePath = resolveStatePath();
  const state = await readAutomationState({ statePath });
  process.stdout.write(formatAutomationState(state, statePath));
}

type RunCliOptions = {
  readonly configPath?: string;
  readonly dryRun: boolean;
  readonly repo?: string;
  readonly workflow?: string;
};

function parseRunArgs(args: ReadonlyArray<string>): RunCliOptions {
  const options: {
    configPath?: string;
    dryRun: boolean;
    repo?: string;
    workflow?: string;
  } = { dryRun: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--config':
      case '-c':
        options.configPath = requireValue(args, index, arg);
        index += 1;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--repo':
        options.repo = requireValue(args, index, arg);
        index += 1;
        break;
      case '--workflow':
        options.workflow = requireValue(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown run option: ${arg}`);
    }
  }

  return options;
}

function requireValue(args: ReadonlyArray<string>, index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function toDaemonOptions(options: RunCliOptions): Omit<RunOptions, 'dryRun'> {
  return {
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
  };
}

function toRunOptions(options: RunCliOptions): RunOptions {
  return {
    dryRun: options.dryRun,
    ...toDaemonOptions(options),
  };
}

function formatError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

await main(process.argv).catch((error: unknown) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
