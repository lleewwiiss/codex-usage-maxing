import { CodexAppServerClient, type CodexAppServerClientOptions } from './app-server-client.js';

export type CodexActiveThreadStatus = {
  readonly activeFlags: ReadonlyArray<string>;
  readonly type: 'active';
};

export type CodexThreadStatus =
  | CodexActiveThreadStatus
  | { readonly type: 'idle' }
  | { readonly type: 'notLoaded' }
  | { readonly type: 'systemError' };

export type CodexThreadSummary = {
  readonly cwd: string;
  readonly name: string | null;
  readonly preview: string;
  readonly source: string;
  readonly status: CodexThreadStatus;
  readonly threadId: string;
  readonly updatedAt: number;
};

export type CodexActiveThreadSummary = CodexThreadSummary & {
  readonly status: CodexActiveThreadStatus;
};

export type CodexActivitySnapshot = {
  readonly activeThreads: ReadonlyArray<CodexActiveThreadSummary>;
  readonly checkedThreadCount: number;
  readonly isUserActive: boolean;
};

export type CodexActivityOptions = CodexAppServerClientOptions & {
  /**
   * Thread IDs currently owned by this orchestrator. Any other active thread is treated as user
   * activity and must preempt automation.
   */
  readonly ownedThreadIds?: Iterable<string>;
  readonly pageSize?: number;
};

type ThreadListPage = {
  readonly data: ReadonlyArray<CodexThreadSummary>;
  readonly nextCursor: string | null;
};

const ALL_THREAD_SOURCE_KINDS = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
] as const;
const DEFAULT_PAGE_SIZE = 100;

export async function readCodexActivity(
  options: CodexActivityOptions = {},
): Promise<CodexActivitySnapshot> {
  const client = await CodexAppServerClient.connect(options);
  try {
    return await readCodexActivityWithClient(client, options);
  } finally {
    client.dispose();
  }
}

export function normalizeCodexActivity(
  threads: ReadonlyArray<CodexThreadSummary>,
  options: Pick<CodexActivityOptions, 'ownedThreadIds'> = {},
): CodexActivitySnapshot {
  const ownedThreadIds = new Set(options.ownedThreadIds ?? []);
  const activeThreads = threads.filter((thread): thread is CodexActiveThreadSummary =>
    isNonOwnedActiveThread(thread, ownedThreadIds),
  );

  return {
    activeThreads,
    checkedThreadCount: threads.length,
    isUserActive: activeThreads.length > 0,
  };
}

async function readCodexActivityWithClient(
  client: CodexAppServerClient,
  options: CodexActivityOptions,
): Promise<CodexActivitySnapshot> {
  const ownedThreadIds = new Set(options.ownedThreadIds ?? []);
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const activeThreads: Array<CodexActiveThreadSummary> = [];
  const seenCursors = new Set<string>();
  let checkedThreadCount = 0;
  let cursor: string | null = null;

  do {
    if (cursor !== null) {
      if (seenCursors.has(cursor)) {
        throw new Error(`Codex app-server returned a repeated thread/list cursor: ${cursor}.`);
      }
      seenCursors.add(cursor);
    }

    const response = await client.request('thread/list', {
      archived: false,
      cursor,
      limit: pageSize,
      sortDirection: 'desc',
      sortKey: 'updated_at',
      sourceKinds: ALL_THREAD_SOURCE_KINDS,
      useStateDbOnly: true,
    });
    const page = parseThreadListPage(response);
    const snapshot = normalizeCodexActivity(page.data, { ownedThreadIds });

    checkedThreadCount += snapshot.checkedThreadCount;
    activeThreads.push(...snapshot.activeThreads);

    cursor = page.nextCursor;
  } while (cursor !== null);

  return { activeThreads, checkedThreadCount, isUserActive: activeThreads.length > 0 };
}

function parseThreadListPage(value: unknown): ThreadListPage {
  if (!isRecord(value) || !Array.isArray(value['data'])) {
    throw new Error('Codex app-server returned an invalid thread/list response.');
  }

  return {
    data: value['data'].map(parseThreadSummary),
    nextCursor: parseNullableString(value['nextCursor'], 'nextCursor'),
  };
}

function parseThreadSummary(value: unknown): CodexThreadSummary {
  if (!isRecord(value)) {
    throw new Error('Codex app-server returned an invalid thread entry.');
  }

  const status = parseThreadStatus(value['status']);
  return {
    cwd: parseString(value['cwd'], 'cwd'),
    name: parseOptionalString(value['name'], 'name'),
    preview: parseString(value['preview'], 'preview'),
    source: formatSessionSource(value['source']),
    status,
    threadId: parseString(value['id'], 'id'),
    updatedAt: parseNumber(value['updatedAt'], 'updatedAt'),
  };
}

function isNonOwnedActiveThread(
  thread: CodexThreadSummary,
  ownedThreadIds: ReadonlySet<string>,
): thread is CodexActiveThreadSummary {
  return thread.status.type === 'active' && !ownedThreadIds.has(thread.threadId);
}

function parseThreadStatus(value: unknown): CodexThreadStatus {
  if (!isRecord(value)) {
    throw new Error('Codex app-server returned an invalid thread status.');
  }

  const type = parseString(value['type'], 'status.type');
  switch (type) {
    case 'active':
      return { activeFlags: parseStringArray(value['activeFlags'], 'activeFlags'), type };
    case 'idle':
    case 'notLoaded':
    case 'systemError':
      return { type };
    default:
      throw new Error(`Codex app-server returned unknown thread status: ${type}.`);
  }
}

function formatSessionSource(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!isRecord(value)) {
    return 'unknown';
  }

  const custom = value['custom'];
  if (typeof custom === 'string') {
    return `custom:${custom}`;
  }

  if ('subAgent' in value || 'subagent' in value) {
    return 'subAgent';
  }

  return 'unknown';
}

function parseString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Codex app-server returned invalid ${field}.`);
  }
  return value;
}

function parseNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new Error(`Codex app-server returned invalid ${field}.`);
  }
  return value;
}

function parseStringArray(value: unknown, field: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Codex app-server returned invalid ${field}.`);
  }
  return value;
}

function parseOptionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`Codex app-server returned invalid ${field}.`);
  }

  return value;
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }

  return parseString(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
