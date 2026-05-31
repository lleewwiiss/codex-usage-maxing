import type { CodexQuotaSnapshot, NormalizedQuotaWindow } from '../codex/quota.js';
import type { QuotaWindowPolicy } from '../config/default-config.js';

export type QuotaPolicyConfig = {
  readonly quota: {
    readonly session: QuotaWindowPolicy;
    readonly weekly: QuotaWindowPolicy;
  };
};

export type QuotaDecision = {
  readonly allowed: boolean;
  readonly reason: string;
};

export function decideQuota(
  config: QuotaPolicyConfig,
  quota: CodexQuotaSnapshot,
  nowMs = Date.now(),
): QuotaDecision {
  const session = decideQuotaWindow('5h session', config.quota.session, quota.session, nowMs);
  if (!session.allowed) {
    return session;
  }

  const weekly = decideQuotaWindow('weekly', config.quota.weekly, quota.weekly, nowMs);
  if (!weekly.allowed) {
    return weekly;
  }

  return { allowed: true, reason: 'quota policy allows a run' };
}

function decideQuotaWindow(
  name: string,
  policy: QuotaWindowPolicy,
  window: NormalizedQuotaWindow,
  nowMs: number,
): QuotaDecision {
  const minutesUntilReset = (window.resetsAt * 1000 - nowMs) / 60_000;
  const draining = minutesUntilReset <= policy.drainWhenResetWithinMinutes;
  const threshold = draining
    ? policy.drainReserveRemaining
    : Math.max(policy.minRemainingToStart, policy.reserveRemaining);

  if (window.remainingPercent <= threshold) {
    return {
      allowed: false,
      reason: `${name} quota at ${window.remainingPercent}% <= ${threshold}% ${draining ? 'drain' : 'normal'} reserve`,
    };
  }

  return { allowed: true, reason: `${name} quota ok` };
}
