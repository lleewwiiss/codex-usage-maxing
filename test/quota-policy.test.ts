import { describe, expect, test } from 'bun:test';

import type { CodexQuotaSnapshot } from '../src/codex/quota.js';
import { decideQuota, type QuotaPolicyConfig } from '../src/orchestrator/quota-policy.js';

const config = {
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
} satisfies QuotaPolicyConfig;

describe('decideQuota', () => {
  test('keeps the normal reserve when reset is not close', () => {
    expect(decideQuota(config, quota({ sessionRemaining: 25 }), 0)).toMatchObject({
      allowed: false,
      reason: '5h session quota at 25% <= 30% normal reserve',
    });
  });

  test('uses the lower drain reserve near reset', () => {
    expect(
      decideQuota(config, quota({ sessionRemaining: 25, sessionResetsAt: 30 * 60 }), 0),
    ).toMatchObject({ allowed: true });
  });

  test('still preserves the drain reserve near reset', () => {
    expect(
      decideQuota(config, quota({ sessionRemaining: 5, sessionResetsAt: 30 * 60 }), 0),
    ).toMatchObject({
      allowed: false,
      reason: '5h session quota at 5% <= 5% drain reserve',
    });
  });
});

function quota(input: {
  readonly sessionRemaining: number;
  readonly sessionResetsAt?: number;
  readonly weeklyRemaining?: number;
  readonly weeklyResetsAt?: number;
}): CodexQuotaSnapshot {
  return {
    credits: null,
    planType: null,
    session: {
      remainingPercent: input.sessionRemaining,
      resetsAt: input.sessionResetsAt ?? 24 * 60 * 60,
      usedPercent: 100 - input.sessionRemaining,
      windowDurationMins: 300,
    },
    weekly: {
      remainingPercent: input.weeklyRemaining ?? 99,
      resetsAt: input.weeklyResetsAt ?? 7 * 24 * 60 * 60,
      usedPercent: 100 - (input.weeklyRemaining ?? 99),
      windowDurationMins: 10_080,
    },
  };
}
