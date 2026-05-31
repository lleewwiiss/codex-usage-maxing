export type WorkflowDefinition =
  | CodexPromptWorkflow
  | CodexSkillsWorkflow
  | CommandWorkflow
  | FindingsToFixWorkflow;

export type WorkflowBase = {
  readonly id: string;
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
  readonly command: string;
  readonly type: 'command';
};

export type FindingsToFixWorkflow = WorkflowBase & {
  readonly findingsFile: string;
  readonly type: 'findings-to-fix';
};
