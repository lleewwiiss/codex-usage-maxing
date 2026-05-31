import { describe, expect, test } from 'bun:test';

import { formatQuota } from '../src/codex/format-quota.js';
import type { CodexQuotaSnapshot } from '../src/codex/quota.js';

describe('formatQuota', () => {
  test('omits credits when credits are absent', () => {
    expect(formatQuota(quota({ credits: null }))).not.toContain('undefined');
    expect(formatQuota(quota({ credits: null }))).not.toContain('Credits:');
  });

  test('omits credits when the balance is absent', () => {
    expect(
      formatQuota(quota({ credits: { balance: null, hasCredits: true, unlimited: false } })),
    ).not.toContain('Credits:');
  });

  test('prints credits when the balance is present', () => {
    expect(
      formatQuota(quota({ credits: { balance: '12.50', hasCredits: true, unlimited: false } })),
    ).toContain('Credits: 12.50');
  });
});

function quota(overrides: Pick<CodexQuotaSnapshot, 'credits'>): CodexQuotaSnapshot {
  return {
    credits: overrides.credits,
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
  };
}
