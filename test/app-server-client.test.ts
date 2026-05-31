import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { readCodexActivity } from '../src/codex/activity.js';
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

  test('passes CODEX_HOME to the app-server process', async () => {
    await withFakeCodex(envCheckingServer('/tmp/codex-home'), async (codexBin) => {
      const client = await CodexAppServerClient.connect({ codexBin, codexHome: '/tmp/codex-home' });
      client.dispose();
    });
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

  test('reads active local threads through a JSON-RPC app-server process', async () => {
    await withFakeCodex(activeThreadServer(), async (codexBin) => {
      await expect(readCodexActivity({ codexBin })).resolves.toMatchObject({
        activeThreads: [{ threadId: 'thread-user-active' }],
        checkedThreadCount: 2,
        isUserActive: true,
      });
    });
  });

  test('scans all thread/list pages before returning active threads', async () => {
    await withFakeCodex(paginatedActiveThreadServer(), async (codexBin) => {
      await expect(readCodexActivity({ codexBin, pageSize: 1 })).resolves.toMatchObject({
        activeThreads: [
          { threadId: 'thread-active-page-one' },
          { threadId: 'thread-active-page-two' },
        ],
        checkedThreadCount: 2,
        isUserActive: true,
      });
    });
  });

  test('fails closed when thread/list omits required pagination', async () => {
    await withFakeCodex(missingCursorThreadServer(), async (codexBin) => {
      await expect(readCodexActivity({ codexBin })).rejects.toThrow('invalid nextCursor');
    });
  });

  test('fails closed when thread/list repeats a cursor', async () => {
    await withFakeCodex(repeatedCursorThreadServer(), async (codexBin) => {
      await expect(readCodexActivity({ codexBin, pageSize: 1 })).rejects.toThrow(
        'repeated thread/list cursor',
      );
    });
  });

  test('fails closed on malformed thread status', async () => {
    await withFakeCodex(malformedThreadServer(), async (codexBin) => {
      await expect(readCodexActivity({ codexBin })).rejects.toThrow('unknown thread status');
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
if [ "$1" != "app-server" ] || [ "$2" != "--listen" ] || [ "$3" != "stdio://" ] || [ "$4" != "" ]; then
  echo "unexpected codex args: $*" >&2
  exit 64
fi
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
if [ "$1" != "app-server" ] || [ "$2" != "--listen" ] || [ "$3" != "stdio://" ] || [ "$4" != "" ]; then
  echo "unexpected codex args: $*" >&2
  exit 64
fi
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
  return appServerScript(`
        if (message.method === 'account/rateLimits/read') {
          writeResponse(message.id, {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 100 },
              secondary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 200 },
            },
          });
        }
  `);
}

function activeThreadServer(): string {
  return appServerScript(`
        if (message.method === 'thread/list') {
          writeResponse(message.id, {
            data: [
              {
                id: 'thread-idle',
                cwd: '/tmp/repo',
                name: null,
                preview: 'idle work',
                source: 'cli',
                status: { type: 'idle' },
                updatedAt: 100,
              },
              {
                id: 'thread-user-active',
                cwd: '/tmp/other',
                name: 'user work',
                preview: 'active work',
                source: 'vscode',
                status: { type: 'active', activeFlags: ['waitingOnApproval'] },
                updatedAt: 200,
              },
            ],
            nextCursor: null,
          });
        }
  `);
}

function envCheckingServer(codexHome: string): string {
  return appServerScript(
    '',
    `
    if (process.env.CODEX_HOME !== ${JSON.stringify(codexHome)}) {
      process.stderr.write('wrong CODEX_HOME\\n');
      process.exit(8);
    }
  `,
  );
}

function paginatedActiveThreadServer(): string {
  return appServerScript(`
        if (message.method === 'thread/list') {
          const secondPage = message.params?.cursor === 'page-two';
          writeResponse(message.id, secondPage ? {
            data: [
              {
                id: 'thread-active-page-two',
                cwd: '/tmp/other',
                preview: 'active page two',
                source: 'cli',
                status: { type: 'active', activeFlags: [] },
                updatedAt: 200,
              },
            ],
            nextCursor: null,
          } : {
            data: [
              {
                id: 'thread-active-page-one',
                cwd: '/tmp/repo',
                preview: 'active page one',
                source: 'cli',
                status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
                updatedAt: 100,
              },
            ],
            nextCursor: 'page-two',
          });
        }
  `);
}

function missingCursorThreadServer(): string {
  return appServerScript(`
        if (message.method === 'thread/list') {
          writeResponse(message.id, {
            data: [
              {
                id: 'thread-idle',
                cwd: '/tmp/repo',
                preview: 'idle work',
                source: 'cli',
                status: { type: 'idle' },
                updatedAt: 100,
              },
            ],
          });
        }
  `);
}

function repeatedCursorThreadServer(): string {
  return appServerScript(`
        if (message.method === 'thread/list') {
          writeResponse(message.id, {
            data: [
              {
                id: 'thread-idle',
                cwd: '/tmp/repo',
                preview: 'idle work',
                source: 'cli',
                status: { type: 'idle' },
                updatedAt: 100,
              },
            ],
            nextCursor: 'same-cursor',
          });
        }
  `);
}

function malformedThreadServer(): string {
  return appServerScript(`
        if (message.method === 'thread/list') {
          writeResponse(message.id, {
            data: [
              {
                id: 'thread-mystery',
                cwd: '/tmp/repo',
                preview: 'mystery work',
                source: 'cli',
                status: { type: 'mystery' },
                updatedAt: 100,
              },
            ],
            nextCursor: null,
          });
        }
  `);
}

function appServerScript(handleMessage: string, prelude = ''): string {
  return `
${prelude}
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
        if (line.trim().length === 0) {
          continue;
        }
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          if (message.params?.clientInfo?.version !== '0.1.1') {
            process.stderr.write('wrong client version\\n');
            process.exit(9);
          }
          writeResponse(message.id, {});
        }
${handleMessage}
      }
    });
  `;
}
