import { describe, expect, test } from 'bun:test';

import { normalizeCodexQuota, type RateLimitSnapshot } from '../src/codex/quota.js';

describe('normalizeCodexQuota', () => {
  test('maps 300-minute and 10080-minute windows to session and weekly', () => {
    const snapshot: RateLimitSnapshot = {
      credits: { balance: '12.50', hasCredits: true, unlimited: false },
      limitId: 'codex',
      planType: 'pro',
      primary: { resetsAt: 100, usedPercent: 21, windowDurationMins: 300 },
      secondary: { resetsAt: 200, usedPercent: 4, windowDurationMins: 10_080 },
    };

    expect(normalizeCodexQuota({ rateLimits: snapshot })).toEqual({
      credits: { balance: '12.50', hasCredits: true, unlimited: false },
      planType: 'pro',
      session: {
        remainingPercent: 79,
        resetsAt: 100,
        usedPercent: 21,
        windowDurationMins: 300,
      },
      weekly: {
        remainingPercent: 96,
        resetsAt: 200,
        usedPercent: 4,
        windowDurationMins: 10_080,
      },
    });
  });

  test('normalizes windows even if Codex returns them swapped', () => {
    const snapshot: RateLimitSnapshot = {
      limitId: 'codex',
      primary: { resetsAt: 200, usedPercent: 4, windowDurationMins: 10_080 },
      secondary: { resetsAt: 100, usedPercent: 21, windowDurationMins: 300 },
    };

    const quota = normalizeCodexQuota({ rateLimits: snapshot });

    expect(quota.session.resetsAt).toBe(100);
    expect(quota.weekly.resetsAt).toBe(200);
  });

  test('fails closed when the weekly window is missing', () => {
    const snapshot: RateLimitSnapshot = {
      limitId: 'codex',
      primary: { resetsAt: 100, usedPercent: 21, windowDurationMins: 300 },
      secondary: null,
    };

    expect(() => normalizeCodexQuota({ rateLimits: snapshot })).toThrow('weekly window');
  });

  test('fails closed when the response is not explicitly for Codex', () => {
    const snapshot: RateLimitSnapshot = {
      primary: { resetsAt: 100, usedPercent: 21, windowDurationMins: 300 },
      secondary: { resetsAt: 200, usedPercent: 4, windowDurationMins: 10_080 },
    };

    expect(() => normalizeCodexQuota({ rateLimits: snapshot })).toThrow('limitId "codex"');
  });

  test('uses the codex bucket from rateLimitsByLimitId', () => {
    const defaultSnapshot: RateLimitSnapshot = {
      limitId: 'other',
      primary: { resetsAt: 300, usedPercent: 99, windowDurationMins: 300 },
      secondary: { resetsAt: 400, usedPercent: 99, windowDurationMins: 10_080 },
    };

    const codexSnapshot: RateLimitSnapshot = {
      limitId: 'codex',
      primary: { resetsAt: 100, usedPercent: 21, windowDurationMins: 300 },
      secondary: { resetsAt: 200, usedPercent: 4, windowDurationMins: 10_080 },
    };

    const quota = normalizeCodexQuota({
      rateLimits: defaultSnapshot,
      rateLimitsByLimitId: { codex: codexSnapshot },
    });

    expect(quota.session.remainingPercent).toBe(79);
    expect(quota.weekly.remainingPercent).toBe(96);
  });
});
