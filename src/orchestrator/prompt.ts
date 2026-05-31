import { dirname, join } from 'node:path';

import {
  createWorkflowSlot,
  hashWorkflowConfig,
  renderManagedPrInstructions,
} from '../runner/idempotent-run.js';
import type { ResolvedRepoConfig } from '../config/load-config.js';
import type { WorkflowDefinition } from '../workflows/types.js';

export type CodexJobPromptInput = {
  readonly githubRepo: string;
  readonly repo: ResolvedRepoConfig;
  readonly runId: string;
  readonly workflow: WorkflowDefinition;
};

export type CodexJobPrompt = {
  readonly branchName: string;
  readonly prompt: string;
  readonly slotKey: string;
  readonly worktreePath: string;
};

export function buildCodexJobPrompt(input: CodexJobPromptInput): CodexJobPrompt {
  const slot = createWorkflowSlot({
    baseBranch: input.repo.base,
    githubRepo: input.githubRepo,
    workflowId: input.workflow.id,
  });
  const configHash = hashWorkflowConfig(input.workflow);
  const worktreePath = join(dirname(input.repo.path), '.codex-usage-maxing', slot.worktreeName);
  const prompt = `codex-usage-maxing job ${input.runId}

You are a Codex agent launched by codex-usage-maxing.

Job ID: ${input.runId}
Repository: ${input.repo.path}
GitHub repo: ${input.githubRepo}
Base branch: ${input.repo.base}
Workflow: ${input.workflow.id}
Slot key: ${slot.slotKey}
Managed branch: ${slot.branchName}
Managed worktree: ${worktreePath}

Hard rules:
- User-initiated Codex work always has priority. If you notice user work or ambiguous state, stop and report.
- Fetch latest upstream before doing anything: git fetch origin ${input.repo.base}.
- If the managed branch or draft PR already exists, resume that exact branch/PR. Do not create a duplicate PR for this slot.
- If resuming, sync with latest origin/${input.repo.base} before continuing. Rebase or merge safely; if conflicts are not straightforward, stop and report.
- If no managed branch exists, create/reuse the managed worktree and branch above.
- Make one coherent, bounded change only: no unrelated files, speculative abstractions, placeholder comments, or unvalidated broad changes.
- Create or update a draft PR. Do not mark ready for review and do not merge.
- ${renderManagedPrInstructions({ configHash, slot })}
- If a human touched the PR or branch, stop and report instead of overwriting it.

Workflow instructions:
${formatWorkflow(input.workflow, configHash)}

Validation:
${formatValidation(input.workflow.validation)}

Final response:
- PR URL or branch name
- what changed
- validation result
- whether this was new work, resumed work, skipped, or blocked
`;

  return { branchName: slot.branchName, prompt, slotKey: slot.slotKey, worktreePath };
}

function formatValidation(validation: ReadonlyArray<string> | undefined): string {
  if (validation === undefined || validation.length === 0) {
    return '- Run the repo standard focused validation for your change.';
  }
  return validation.map((command) => `- ${command}`).join('\n');
}

function formatWorkflow(workflow: WorkflowDefinition, configHash: string): string {
  switch (workflow.type) {
    case 'codex-skills':
      return `Config hash: ${configHash}
Skills to read and follow:
${workflow.skills.map((skill) => `- ${skill}`).join('\n')}
Prompt:
${workflow.prompt}`;
    case 'codex-prompt':
      return `Config hash: ${configHash}
Read and follow prompt file: ${workflow.promptFile}`;
    case 'command':
      return `Config hash: ${configHash}
Run command and turn the result into one bounded PR if it finds actionable work:
${workflow.command}`;
    case 'findings-to-fix':
      return `Config hash: ${configHash}
Read findings file and fix one bounded set of findings:
${workflow.findingsFile}`;
  }
}
