import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type CodexAppServerClientOptions = {
  readonly codexBin?: string;
  readonly codexHome?: string;
  readonly requestTimeoutMs?: number;
};

type JsonRpcError = {
  readonly code?: number;
  readonly message?: string;
};

type JsonRpcMessage = {
  readonly error?: JsonRpcError;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
};

type PendingRequest = {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly timer: NodeJS.Timeout;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_STDERR_CHARS = 4000;
const PACKAGE_VERSION = '0.1.0';

export class CodexAppServerClient {
  readonly #codexBin: string;
  readonly #codexHome: string | undefined;
  readonly #requestTimeoutMs: number;
  #disposed = false;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #stderr = '';
  #terminalError: Error | undefined;

  private constructor(options: CodexAppServerClientOptions = {}) {
    this.#codexBin = options.codexBin ?? 'codex';
    this.#codexHome = options.codexHome;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  static async connect(options: CodexAppServerClientOptions = {}): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(options);
    client.start();
    try {
      await client.request('initialize', {
        clientInfo: {
          name: 'codex-usage-maxing',
          title: 'codex-usage-maxing',
          version: PACKAGE_VERSION,
        },
      });
      client.notify('initialized');
      return client;
    } catch (error) {
      client.dispose();
      throw error;
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const process = this.#requireProcess();
    const id = this.#nextId;
    this.#nextId += 1;

    const payload = params === undefined ? { id, method } : { id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(this.#withStderr(`Codex app-server request timed out: ${method}`)));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { reject, resolve, timer });
    });

    process.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  notify(method: string, params?: unknown): void {
    const process = this.#requireProcess();
    const payload = params === undefined ? { method } : { method, params };
    process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  dispose(): void {
    this.#disposed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server client disposed before response.'));
    }
    this.#pending.clear();

    const process = this.#process;
    if (process === undefined) {
      return;
    }

    process.stdin.end();
    process.kill('SIGTERM');
    this.#process = undefined;
  }

  private start(): void {
    this.#disposed = false;
    this.#stderr = '';
    this.#terminalError = undefined;
    const env = {
      ...process.env,
      ...(this.#codexHome === undefined ? {} : { CODEX_HOME: this.#codexHome }),
    };
    const child = spawn(this.#codexBin, ['app-server', '--listen', 'stdio://'], { env });
    this.#process = child;

    createInterface({ input: child.stdout }).on('line', (line) => {
      this.#handleLine(line);
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.#appendStderr(String(chunk));
    });

    child.on('error', (error) => {
      if (this.#disposed) {
        return;
      }
      this.#fail(new Error(this.#withStderr(`Failed to start Codex app-server: ${error.message}`)));
    });

    child.on('exit', (code, signal) => {
      if (this.#disposed) {
        return;
      }
      this.#fail(
        new Error(
          this.#withStderr(`Codex app-server exited unexpectedly: code=${code} signal=${signal}`),
        ),
      );
    });
  }

  #handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(line);
    } catch (error) {
      this.#fail(asError(error));
      return;
    }

    if (message.id === undefined) {
      return;
    }

    if (typeof message.id !== 'number') {
      this.#fail(new Error(`Codex app-server returned unsupported JSON-RPC id: ${message.id}`));
      return;
    }

    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);
    this.#pending.delete(message.id);

    if (message.error !== undefined) {
      pending.reject(
        new Error(message.error.message ?? `Codex app-server error ${message.error.code}`),
      );
      return;
    }

    pending.resolve(message.result);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #fail(error: Error): void {
    this.#terminalError = error;
    const child = this.#process;
    this.#process = undefined;
    if (child !== undefined && !child.killed) {
      child.kill('SIGTERM');
    }
    this.#rejectAll(error);
  }

  #requireProcess(): ChildProcessWithoutNullStreams {
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }

    if (this.#process === undefined) {
      throw new Error('Codex app-server process is not running.');
    }
    return this.#process;
  }

  #appendStderr(chunk: string): void {
    this.#stderr = `${this.#stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
  }

  #withStderr(message: string): string {
    const stderr = this.#stderr.trim();
    return stderr.length === 0 ? message : `${message}\nstderr:\n${stderr}`;
  }
}

function parseJsonRpcMessage(line: string): JsonRpcMessage {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) {
      throw new Error(`Codex app-server returned a non-object JSON-RPC line: ${snippet(line)}`);
    }

    const error = parseJsonRpcError(value['error'], line);
    const id = parseJsonRpcId(value['id'], line);
    const method = parseOptionalString(value['method'], line);
    return {
      ...(error === undefined ? {} : { error }),
      ...(id === undefined ? {} : { id }),
      ...(method === undefined ? {} : { method }),
      params: value['params'],
      result: value['result'],
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Codex app-server returned invalid JSON: ${snippet(line)}`);
    }
    throw error;
  }
}

function parseJsonRpcError(value: unknown, line: string): JsonRpcError | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`Codex app-server returned an invalid JSON-RPC error: ${snippet(line)}`);
  }

  const code = value['code'];
  const message = value['message'];
  return {
    ...(typeof code === 'number' ? { code } : {}),
    ...(typeof message === 'string' ? { message } : {}),
  };
}

function parseJsonRpcId(value: unknown, line: string): number | string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }

  throw new Error(`Codex app-server returned an invalid JSON-RPC id: ${snippet(line)}`);
}

function parseOptionalString(value: unknown, line: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string') {
    return value;
  }

  throw new Error(`Codex app-server returned an invalid JSON-RPC string field: ${snippet(line)}`);
}

function snippet(line: string): string {
  return JSON.stringify(line.slice(0, 200));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
