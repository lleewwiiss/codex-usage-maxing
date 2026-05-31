import type { CodexActivitySnapshot, CodexThreadSummary } from './activity.js';

export function formatActivity(activity: CodexActivitySnapshot): string {
  const state = activity.isUserActive ? 'busy' : 'idle';
  const activeThreads = activity.activeThreads.map(formatActiveThread).join('\n');
  const suffix = activeThreads.length === 0 ? '' : `\n\nActive threads:\n${activeThreads}`;
  return `Codex local activity: ${state}\nChecked threads: ${activity.checkedThreadCount}${suffix}\n`;
}

function formatActiveThread(thread: CodexThreadSummary): string {
  const flags = thread.status.type === 'active' ? thread.status.activeFlags : [];
  const suffix = flags.length === 0 ? '' : ` (${flags.join(', ')})`;
  return `- ${thread.threadId.slice(0, 8)} ${thread.source} ${thread.cwd} — ${thread.name ?? thread.preview}${suffix}`;
}
