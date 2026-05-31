export type WorkflowDefinition =
  | CodexPromptWorkflow
  | CodexSkillsWorkflow
  | CommandWorkflow
  | FindingsToFixWorkflow;

export type WorkflowBase = {
  readonly id: string;
  readonly maxDiffLines?: number;
  readonly maxRuntimeMinutes?: number;
  readonly validation?: ReadonlyArray<string>;
};

export type CodexSkillsWorkflow = WorkflowBase & {
  readonly prompt: string;
  readonly skills: ReadonlyArray<string>;
  readonly type: 'codex-skills';
};

export type CodexPromptWorkflow = WorkflowBase & {
  readonly promptFile: string;
  readonly type: 'codex-prompt';
};

export type CommandWorkflow = WorkflowBase & {
  readonly artifacts?: ReadonlyArray<string>;
  readonly command: string;
  readonly type: 'command';
};

export type FindingsToFixWorkflow = WorkflowBase & {
  readonly findingsFile: string;
  readonly type: 'findings-to-fix';
};

export type WorkflowResult = {
  readonly artifacts: ReadonlyArray<string>;
  readonly changedFiles: ReadonlyArray<string>;
  readonly status: 'changed' | 'empty' | 'failed' | 'findings' | 'interrupted';
  readonly summary: string;
  readonly validation: ReadonlyArray<ValidationResult>;
};

export type ValidationResult = {
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};
