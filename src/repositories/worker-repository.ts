import type { LinearIssue, ModelResult, ModelRole } from "../types/worker.js";

export type ClaimResult = "claimed" | "duplicate" | "busy";

export interface GenerationContext {
  generationId: string;
  taskId: string;
  issueIdentifier: string;
  projectId: string;
  projectName: string;
  model: string;
  role: ModelRole;
  deliveryId: string;
}

export interface WorkerRepository {
  claim(
    issue: LinearIssue,
    deliveryId: string,
    leaseSeconds: number,
    allowNewClaim: boolean,
  ): Promise<ClaimResult>;
  getCompletedGeneration<T>(generationId: string): Promise<ModelResult<T> | null>;
  startGeneration(context: GenerationContext): Promise<void>;
  completeGeneration<T>(context: GenerationContext, result: ModelResult<T>): Promise<void>;
  failGeneration(generationId: string, error: Error): Promise<void>;
  assertWithinBudget(taskId: string, projectId: string, maxTaskMicros: number, maxProjectMicros: number): Promise<void>;
  completeTask(taskId: string, deliveryId: string, status: string, details: object): Promise<void>;
  failTask(taskId: string, deliveryId: string, error: Error): Promise<void>;
}
