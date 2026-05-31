import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'bun:test';

describe('package.json', () => {
  test('publishes an explicit CLI surface', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      readonly bin?: Record<string, string>;
      readonly exports?: unknown;
      readonly files?: ReadonlyArray<string>;
      readonly publishConfig?: { readonly access?: string };
    };

    expect(packageJson.bin).toEqual({ 'codex-usage-maxing': 'dist/cli.js' });
    expect(packageJson.exports).toBeUndefined();
    expect(packageJson.files).toEqual(['dist', 'README.md']);
    expect(packageJson.publishConfig?.access).toBe('public');
  });
});
