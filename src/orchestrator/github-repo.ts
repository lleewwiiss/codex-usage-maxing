import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readGithubRepo(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
  return parseGithubRepo(stdout.trim());
}

export function parseGithubRepo(remoteUrl: string): string {
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remoteUrl);
  if (ssh?.[1] !== undefined) {
    return ssh[1].toLowerCase();
  }

  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remoteUrl);
  if (https?.[1] !== undefined) {
    return https[1].toLowerCase();
  }

  throw new Error(`Unsupported GitHub remote URL: ${remoteUrl}`);
}
