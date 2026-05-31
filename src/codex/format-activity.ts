import type { CodexActivitySnapshot, CodexThreadSummary } from './activity.js';

export function formatActivity(activity: CodexActivitySnapshot): string {
  const state = activity.isUserActive ? 'busy' : 'idle';
  const activeThreads = activity.activeThreads.map(formatActiveThread).join('\n');
  const suffix = activeThreads.length === 0 ? '' : `\n\nActive threads:\n${activeThreads}`;
  return `Codex local activity: ${state}\nChecked threads: ${activity.checkedThreadCount}${suffix}\n`;
}

function formatActiveThread(thread: CodexThreadSummary): string {
  const name = thread.name ?? thread.preview ?? 'untitled';
  const cwd = thread.cwd === null ? 'unknown cwd' : thread.cwd;
  const flags = thread.activeFlags.length === 0 ? '' : ` (${thread.activeFlags.join(', ')})`;
  return `- ${thread.threadId.slice(0, 8)} ${thread.source} ${cwd} — ${name}${flags}`;
}
