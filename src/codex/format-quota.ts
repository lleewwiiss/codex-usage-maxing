import type { CodexQuotaSnapshot } from './quota.js';

export function formatQuota(quota: CodexQuotaSnapshot): string {
  const plan = quota.planType === null ? 'unknown plan' : quota.planType;
  const credits = quota.credits?.balance == null ? '' : `\nCredits: ${quota.credits.balance}`;
  return `Codex quota (${plan})

Session: ${quota.session.remainingPercent}% left, resets ${formatUnixTime(quota.session.resetsAt)}
Weekly:  ${quota.weekly.remainingPercent}% left, resets ${formatUnixTime(quota.weekly.resetsAt)}${credits}
`;
}

function formatUnixTime(value: number): string {
  return new Date(value * 1000).toISOString();
}
