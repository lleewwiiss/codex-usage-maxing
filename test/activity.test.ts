import { describe, expect, test } from 'bun:test';

import {
  normalizeCodexActivity,
  type CodexActiveThreadSummary,
  type CodexThreadSummary,
} from '../src/codex/activity.js';
import { formatActivity } from '../src/codex/format-activity.js';

describe('normalizeCodexActivity', () => {
  test('treats any non-owned active thread as user activity', () => {
    const activity = normalizeCodexActivity(
      [
        thread({ status: { activeFlags: [], type: 'active' }, threadId: 'owned-thread' }),
        thread({
          status: { activeFlags: ['waitingOnUserInput'], type: 'active' },
          threadId: 'user-thread',
        }),
      ],
      { ownedThreadIds: ['owned-thread'] },
    );

    expect(activity).toMatchObject({
      activeThreads: [{ threadId: 'user-thread' }],
      checkedThreadCount: 2,
      isUserActive: true,
    });
  });

  test('does not treat idle, notLoaded, or systemError threads as active', () => {
    const activity = normalizeCodexActivity([
      thread({ status: { type: 'idle' }, threadId: 'idle' }),
      thread({ status: { type: 'notLoaded' }, threadId: 'not-loaded' }),
      thread({ status: { type: 'systemError' }, threadId: 'error' }),
    ]);

    expect(activity).toEqual({ activeThreads: [], checkedThreadCount: 3, isUserActive: false });
  });
});

describe('formatActivity', () => {
  test('prints the busy state and active thread context', () => {
    expect(
      formatActivity({
        activeThreads: [
          activeThread({
            cwd: '/tmp/repo',
            name: 'review fix',
            source: 'cli',
            status: { activeFlags: ['waitingOnApproval'], type: 'active' },
            threadId: '1234567890',
          }),
        ],
        checkedThreadCount: 8,
        isUserActive: true,
      }),
    ).toBe(`Codex local activity: busy
Checked threads: 8

Active threads:
- 12345678 cli /tmp/repo — review fix (waitingOnApproval)
`);
  });
});

function activeThread(overrides: Partial<CodexActiveThreadSummary>): CodexActiveThreadSummary {
  return {
    cwd: '/tmp/repo',
    name: null,
    preview: 'thread preview',
    source: 'cli',
    status: { activeFlags: [], type: 'active' },
    threadId: 'thread-id',
    updatedAt: 100,
    ...overrides,
  };
}

function thread(overrides: Partial<CodexThreadSummary>): CodexThreadSummary {
  return {
    cwd: '/tmp/repo',
    name: null,
    preview: 'thread preview',
    source: 'cli',
    status: { type: 'idle' },
    threadId: 'thread-id',
    updatedAt: 100,
    ...overrides,
  };
}
