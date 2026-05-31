import { CodexAppServerClient, type CodexAppServerClientOptions } from './app-server-client.js';

export const SESSION_WINDOW_MINUTES = 300;
export const WEEKLY_WINDOW_MINUTES = 10_080;

export type RateLimitWindow = {
  readonly resetsAt: number | null;
  readonly usedPercent: number;
  readonly windowDurationMins: number | null;
};

export type CreditsSnapshot = {
  readonly balance: string | null;
  readonly hasCredits: boolean;
  readonly unlimited: boolean;
};

export type RateLimitSnapshot = {
  readonly credits?: CreditsSnapshot | null;
  readonly limitId?: string | null;
  readonly limitName?: string | null;
  readonly planType?: string | null;
  readonly primary?: RateLimitWindow | null;
  readonly rateLimitReachedType?: string | null;
  readonly secondary?: RateLimitWindow | null;
};

type GetAccountRateLimitsResponse = {
  readonly rateLimits: RateLimitSnapshot;
  readonly rateLimitsByLimitId?: Record<string, RateLimitSnapshot | undefined> | null;
};

export type AccountRateLimitsResponse = GetAccountRateLimitsResponse;

export type NormalizedQuotaWindow = {
  readonly remainingPercent: number;
  readonly resetsAt: number;
  readonly usedPercent: number;
  readonly windowDurationMins: typeof SESSION_WINDOW_MINUTES | typeof WEEKLY_WINDOW_MINUTES;
};

export type CodexQuotaSnapshot = {
  readonly credits: CreditsSnapshot | null;
  readonly planType: string | null;
  readonly session: NormalizedQuotaWindow;
  readonly weekly: NormalizedQuotaWindow;
};

export async function readCodexQuota(
  options: CodexAppServerClientOptions = {},
): Promise<CodexQuotaSnapshot> {
  const client = await CodexAppServerClient.connect(options);
  try {
    const response = await client.request('account/rateLimits/read');
    return normalizeCodexQuota(parseRateLimitsResponse(response));
  } finally {
    client.dispose();
  }
}

export function normalizeCodexQuota(response: GetAccountRateLimitsResponse): CodexQuotaSnapshot {
  const snapshot = selectCodexSnapshot(response);
  const windows = [snapshot.primary, snapshot.secondary].filter(isRateLimitWindow);
  const session = windows.find((window) => window.windowDurationMins === SESSION_WINDOW_MINUTES);
  const weekly = windows.find((window) => window.windowDurationMins === WEEKLY_WINDOW_MINUTES);

  if (session === undefined) {
    throw new Error('Codex quota response did not include the 5-hour session window.');
  }

  if (weekly === undefined) {
    throw new Error('Codex quota response did not include the weekly window.');
  }

  return {
    credits: snapshot.credits ?? null,
    planType: snapshot.planType ?? null,
    session: normalizeWindow(session, SESSION_WINDOW_MINUTES),
    weekly: normalizeWindow(weekly, WEEKLY_WINDOW_MINUTES),
  };
}

function selectCodexSnapshot(response: GetAccountRateLimitsResponse): RateLimitSnapshot {
  const byId = response.rateLimitsByLimitId?.['codex'];
  if (byId !== undefined) {
    return byId;
  }

  if (response.rateLimits.limitId === 'codex') {
    return response.rateLimits;
  }

  throw new Error('Codex quota response did not include limitId "codex".');
}

function normalizeWindow(
  window: RateLimitWindow,
  expectedWindowDurationMins: typeof SESSION_WINDOW_MINUTES | typeof WEEKLY_WINDOW_MINUTES,
): NormalizedQuotaWindow {
  if (window.resetsAt === null) {
    throw new Error(`Codex quota window ${expectedWindowDurationMins}m did not include resetsAt.`);
  }

  return {
    remainingPercent: Math.max(0, 100 - window.usedPercent),
    resetsAt: window.resetsAt,
    usedPercent: window.usedPercent,
    windowDurationMins: expectedWindowDurationMins,
  };
}

function parseRateLimitsResponse(value: unknown): GetAccountRateLimitsResponse {
  if (!isRecord(value) || !isRecord(value['rateLimits'])) {
    throw new Error('Codex app-server returned an invalid account/rateLimits/read response.');
  }

  return {
    rateLimits: parseRateLimitSnapshot(value['rateLimits']),
    rateLimitsByLimitId: parseRateLimitsByLimitId(value['rateLimitsByLimitId']),
  };
}

function parseRateLimitsByLimitId(
  value: unknown,
): Record<string, RateLimitSnapshot | undefined> | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isRecord(value)) {
    throw new Error('Codex app-server returned invalid rateLimitsByLimitId.');
  }

  const result: Record<string, RateLimitSnapshot | undefined> = {};
  for (const [key, snapshot] of Object.entries(value)) {
    if (snapshot === undefined) {
      result[key] = undefined;
      continue;
    }
    result[key] = parseRateLimitSnapshot(snapshot);
  }
  return result;
}

function parseRateLimitSnapshot(value: unknown): RateLimitSnapshot {
  if (!isRecord(value)) {
    throw new Error('Codex app-server returned an invalid rate limit snapshot.');
  }

  return {
    credits: parseCreditsSnapshot(value['credits']),
    limitId: parseOptionalString(value['limitId']),
    limitName: parseOptionalString(value['limitName']),
    planType: parseOptionalString(value['planType']),
    primary: parseRateLimitWindow(value['primary']),
    rateLimitReachedType: parseOptionalString(value['rateLimitReachedType']),
    secondary: parseRateLimitWindow(value['secondary']),
  };
}

function parseRateLimitWindow(value: unknown): RateLimitWindow | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isRecord(value)) {
    throw new Error('Codex app-server returned an invalid rate limit window.');
  }

  const usedPercent = parseNumber(value['usedPercent'], 'usedPercent');
  const windowDurationMins = parseOptionalNumber(value['windowDurationMins'], 'windowDurationMins');
  const resetsAt = parseOptionalNumber(value['resetsAt'], 'resetsAt');

  return { resetsAt, usedPercent, windowDurationMins };
}

function parseCreditsSnapshot(value: unknown): CreditsSnapshot | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isRecord(value)) {
    throw new Error('Codex app-server returned invalid credits.');
  }

  return {
    balance: parseOptionalString(value['balance']),
    hasCredits: parseBoolean(value['hasCredits'], 'hasCredits'),
    unlimited: parseBoolean(value['unlimited'], 'unlimited'),
  };
}

function isRateLimitWindow(value: RateLimitWindow | null | undefined): value is RateLimitWindow {
  return value !== null && value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
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

function parseOptionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseNumber(value, field);
}

function parseOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error('Codex app-server returned an invalid string field.');
  }

  return value;
}
