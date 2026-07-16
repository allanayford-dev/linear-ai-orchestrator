import type { RepositoryTarget, ValidationCommand } from "../services/repository-target-policy.js";

export interface RepositoryExecutionRequest {
  taskId: string;
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string | null;
  linearProjectId: string;
  linearProjectName: string;
  repository: RepositoryTarget;
  branchName: string;
  validationCommands: readonly ValidationCommand[];
  maxDurationSeconds: number;
  maxChangedFiles: number;
  maxDiffBytes: number;
}

export type RepositoryExecutionOutcome =
  | "ready_for_review"
  | "needs_action"
  | "validation_failed"
  | "rejected";

export interface ValidationEvidence {
  command: ValidationCommand;
  exitCode: number;
  outputSummary: string;
}

export interface RepositoryExecutionResult {
  outcome: RepositoryExecutionOutcome;
  repositoryFullName: string;
  baseBranch: string;
  branchName: string;
  commitSha: string | null;
  pullRequestUrl: string | null;
  changedFiles: readonly string[];
  validation: readonly ValidationEvidence[];
  summary: string;
  handoffReason: string | null;
}
