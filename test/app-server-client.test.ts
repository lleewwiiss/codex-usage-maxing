import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { CodexAppServerClient } from '../src/codex/app-server-client.js';
import { readCodexQuota } from '../src/codex/quota.js';

describe('CodexAppServerClient', () => {
  test('reads quota through a JSON-RPC app-server process', async () => {
    await withFakeCodex(validQuotaServer(), async (codexBin) => {
      await expect(readCodexQuota({ codexBin })).resolves.toMatchObject({
        session: { remainingPercent: 79 },
        weekly: { remainingPercent: 96 },
      });
    });
  });

  test('surfaces stderr when the app-server exits during initialization', async () => {
    await withFakeCodex(
      `process.stderr.write('auth broke\\n'); process.exit(7);`,
      async (codexBin) => {
        await expect(CodexAppServerClient.connect({ codexBin })).rejects.toThrow('auth broke');
      },
    );
  });

  test('fails fast on malformed JSON-RPC instead of timing out', async () => {
    await withFakeCodex(
      `process.stdout.write('not json\\n'); setInterval(() => undefined, 1000);`,
      async (codexBin) => {
        await expect(CodexAppServerClient.connect({ codexBin })).rejects.toThrow('invalid JSON');
      },
    );
  });

  test('disposes a process when initialization times out', async () => {
    await withTempDirectory(async (directory) => {
      const pidFile = join(directory, 'pid');
      const codexBin = await writeHangingCodex(directory, pidFile);

      const connect = CodexAppServerClient.connect({ codexBin, requestTimeoutMs: 500 });
      const pid = await waitForPidFile(pidFile);
      await expect(connect).rejects.toThrow('timed out');
      await expect(waitForProcessExit(pid)).resolves.toBe(true);
    });
  });
});

async function withFakeCodex(
  source: string,
  callback: (codexBin: string) => Promise<void>,
): Promise<void> {
  await withTempDirectory(async (directory) => {
    const codexBin = await writeFakeCodex(directory, source);
    await callback(codexBin);
  });
}

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-usage-maxing-'));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function writeFakeCodex(directory: string, source: string): Promise<string> {
  const codexBin = join(directory, 'codex');
  await writeFile(
    codexBin,
    `#!/bin/sh
exec ${shellQuote(process.execPath)} -e ${shellQuote(source)} "$@"
`,
  );
  await chmod(codexBin, 0o755);
  return codexBin;
}

async function writeHangingCodex(directory: string, pidFile: string): Promise<string> {
  const codexBin = join(directory, 'codex');
  await writeFile(
    codexBin,
    `#!/bin/sh
echo $$ > ${shellQuote(pidFile)}
while true; do sleep 1; done
`,
  );
  await chmod(codexBin, 0o755);
  return codexBin;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function waitForPidFile(pidFile: string): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return Number(await readFile(pidFile, 'utf8'));
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error(`Timed out waiting for fake Codex pid file: ${pidFile}`);
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function validQuotaServer(): string {
  return `
    process.stdin.setEncoding('utf8');
    let buffer = '';
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
        }
        if (message.method === 'account/rateLimits/read') {
          process.stdout.write(JSON.stringify({
            id: message.id,
            result: {
              rateLimits: {
                limitId: 'codex',
                primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 100 },
                secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 200 },
              },
            },
          }) + '\\n');
        }
      }
    });
  `;
}
