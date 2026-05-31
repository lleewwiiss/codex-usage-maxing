import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

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
});

type CliResult = {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
};

async function runCli(args: ReadonlyArray<string>, cwd = process.cwd()): Promise<CliResult> {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd,
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
