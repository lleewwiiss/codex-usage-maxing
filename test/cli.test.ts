import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

import { readAutomationState } from '../src/orchestrator/state.js';

const CONFIG_FILE_NAME = 'codex-usage-maxing.config.jsonc';
const CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

describe('cli', () => {
  test('prints help by default', async () => {
    const result = await runCli([]);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('codex-usage-maxing');
    expect(result.stdout).toContain('Commands:');
  });

  test('reports unknown commands with a non-zero exit', async () => {
    const result = await runCli(['nope']);

    expect(result).toMatchObject({ exitCode: 1, stdout: '' });
    expect(result.stderr).toBe('Unknown command: nope\n');
  });

  test('shows automation state without requiring Codex', async () => {
    await withTempDirectory(async (directory) => {
      const statePath = join(directory, 'state.json');
      const result = await runCli(['runs'], directory, { CODEX_USAGE_MAXING_STATE: statePath });

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(result.stdout).toContain('Last decision: none yet');
      expect(result.stdout).toContain(statePath);
    });
  });

  test('init writes the starter config and refuses to overwrite it', async () => {
    await withTempDirectory(async (directory) => {
      const first = await runCli(['init'], directory);
      const configPath = join(directory, CONFIG_FILE_NAME);

      expect(first).toMatchObject({ exitCode: 0, stderr: '' });
      expect(first.stdout).toContain(`/${CONFIG_FILE_NAME}\n`);
      await expect(readFile(configPath, 'utf8')).resolves.toContain('"repos"');

      const second = await runCli(['init'], directory);
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain('EEXIST');
      expect(second.stderr).toContain(CONFIG_FILE_NAME);
    });
  });

  test('run --dry-run prints the selected Codex job without writing state', async () => {
    await withRunnableFixture(async ({ configPath, directory, statePath }) => {
      const result = await runCli(['run', '--config', configPath, '--dry-run'], directory, {
        CODEX_USAGE_MAXING_STATE: statePath,
      });

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(result.stdout).toContain('codex-usage-maxing dry run');
      expect(result.stdout).toContain('Codex command');
      expect(result.stdout).toContain('Prompt preview');
      expect(result.stdout).toContain('Automation state unchanged.');
      await expect(readFile(statePath, 'utf8')).rejects.toThrow();
    });
  });

  test('run launches codex exec and records the completed decision', async () => {
    await withRunnableFixture(async ({ configPath, directory, promptPath, statePath }) => {
      const result = await runCli(['run', '--config', configPath], directory, {
        CODEX_USAGE_MAXING_STATE: statePath,
      });

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      expect(result.stdout).toContain('fake codex exec complete');
      await expect(readFile(promptPath, 'utf8')).resolves.toContain('Managed branch:');

      const state = await readAutomationState({ statePath });
      expect(state?.latest).toMatchObject({ reason: 'Codex completed', status: 'run' });
    });
  });

  test('run skips while a recent user Codex thread is inside the idle window', async () => {
    await withRunnableFixture(
      async ({ configPath, directory, promptPath, statePath }) => {
        const result = await runCli(['run', '--config', configPath], directory, {
          CODEX_USAGE_MAXING_STATE: statePath,
        });

        expect(result).toMatchObject({ exitCode: 0, stderr: '' });
        expect(result.stdout).toContain('waiting for 15m Codex idle window');
        await expect(readFile(promptPath, 'utf8')).rejects.toThrow();

        const state = await readAutomationState({ statePath });
        expect(state?.latest).toMatchObject({
          reason: 'waiting for 15m Codex idle window',
          status: 'skip',
        });
      },
      { threadUpdatedAt: Date.now() },
    );
  });
});

type CliResult = {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
};

async function runCli(
  args: ReadonlyArray<string>,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Array<Buffer> = [];
  const stderr: Array<Buffer> = [];

  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  return {
    exitCode,
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  };
}

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-usage-maxing-cli-'));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

type RunnableFixture = {
  readonly configPath: string;
  readonly directory: string;
  readonly promptPath: string;
  readonly statePath: string;
};

async function withRunnableFixture(
  callback: (fixture: RunnableFixture) => Promise<void>,
  options: { readonly threadUpdatedAt?: number } = {},
): Promise<void> {
  await withTempDirectory(async (directory) => {
    const repoPath = join(directory, 'repo');
    await mkdir(repoPath);
    await runProcess('git', ['init'], repoPath);
    await runProcess(
      'git',
      ['remote', 'add', 'origin', 'git@github.com:lleewwiiss/example.git'],
      repoPath,
    );

    const promptPath = join(directory, 'prompt.txt');
    const codexBin = await writeFakeCodex(directory, promptPath, options);
    const configPath = join(directory, CONFIG_FILE_NAME);
    const statePath = join(directory, 'state.json');
    await writeFile(configPath, JSON.stringify(createConfig({ codexBin, repoPath }), null, 2));

    await callback({ configPath, directory, promptPath, statePath });
  });
}

async function runProcess(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<void> {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr: Array<Buffer> = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${Buffer.concat(stderr).toString('utf8')}`,
    );
  }
}

async function writeFakeCodex(
  directory: string,
  promptPath: string,
  options: { readonly threadUpdatedAt?: number },
): Promise<string> {
  const codexBin = join(directory, 'codex');
  await writeFile(
    codexBin,
    `#!/bin/sh
if [ "$1" = "app-server" ]; then
  exec ${shellQuote(process.execPath)} -e ${shellQuote(appServerScript(options))} "$@"
fi
if [ "$1" = "exec" ]; then
  cat > ${shellQuote(promptPath)}
  echo "fake codex exec complete"
  exit 0
fi
echo "unexpected codex args: $*" >&2
exit 64
`,
  );
  await chmod(codexBin, 0o755);
  return codexBin;
}

function appServerScript(options: { readonly threadUpdatedAt?: number }): string {
  const threadData =
    options.threadUpdatedAt === undefined
      ? []
      : [
          {
            cwd: '/tmp/other',
            id: 'recent-idle-thread',
            name: 'recent user work',
            preview: 'recent user work',
            source: 'cli',
            status: { type: 'idle' },
            updatedAt: options.threadUpdatedAt,
          },
        ];

  return `
    process.stdin.setEncoding('utf8');
    let buffer = '';
    function writeResponse(id, result) {
      process.stdout.write(JSON.stringify({ id, result }) + '\\n');
    }
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          writeResponse(message.id, {});
        }
        if (message.method === 'account/rateLimits/read') {
          writeResponse(message.id, {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 100 },
              secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 200 },
            },
          });
        }
        if (message.method === 'thread/list') {
          writeResponse(message.id, { data: ${JSON.stringify(threadData)}, nextCursor: null });
        }
      }
    });
  `;
}

function createConfig(input: { readonly codexBin: string; readonly repoPath: string }) {
  return {
    activity: { idleRequiredMinutes: 15, interruptOnUserCodex: true },
    codex: { askForApproval: 'never', bin: input.codexBin, sandbox: 'workspace-write' },
    daemon: { interruptPollSeconds: 30, intervalMinutes: 15 },
    quota: {
      session: {
        drainReserveRemaining: 5,
        drainWhenResetWithinMinutes: 45,
        minRemainingToStart: 30,
        reserveRemaining: 15,
      },
      weekly: {
        drainReserveRemaining: 3,
        drainWhenResetWithinMinutes: 480,
        minRemainingToStart: 20,
        reserveRemaining: 10,
      },
    },
    repos: [
      {
        base: 'main',
        path: input.repoPath,
        workflows: [
          {
            id: 'improve-tests',
            prompt: 'Find one bounded test improvement.',
            skills: ['~/.agents/skills/improve-test-suite/SKILL.md'],
            type: 'codex-skills',
            validation: ['bun test'],
          },
        ],
      },
    ],
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
