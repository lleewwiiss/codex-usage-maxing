#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { formatActivity } from './codex/format-activity.js';
import { formatQuota } from './codex/format-quota.js';
import { readCodexActivity } from './codex/activity.js';
import { readCodexQuota } from './codex/quota.js';
import { defaultConfigText } from './config/default-config.js';

const CONFIG_FILE_NAME = 'codex-usage-maxing.config.jsonc';

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
    case 'status': {
      const quota = await readCodexQuota();
      process.stdout.write(formatQuota(quota));
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
  init      Write ${CONFIG_FILE_NAME} in the current directory
  status    Read native Codex 5h session + weekly quota
  help      Show this help
`);
}

async function initConfig(): Promise<void> {
  const configPath = join(process.cwd(), CONFIG_FILE_NAME);
  await writeFile(configPath, defaultConfigText, { flag: 'wx' });
  process.stdout.write(`Wrote ${configPath}\n`);
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
