import type {
  LinearIssue,
  ModelProvider,
  ModelResult,
  ModelRole,
  PricingTier,
} from "../types/worker.js";

export type ClaimResult =
  | "claimed"
  | "recovered"
  | "duplicate"
  | "busy"
  | "delivery_limit";
export type FailedGenerationResult = Omit<ModelResult<unknown>, "value">;

export interface LinearStateSync {
  deliveryId: string;
  eventTimestamp: number;
  source: "linear-webhook" | "worker-transition" | "backfill";
}

export interface LinearStateSyncResult {
  outcome: "updated" | "unchanged" | "duplicate" | "stale";
  resumeCurrentDelivery: boolean;
}

export interface GenerationContext {
  generationId: string;
  taskId: string;
  issueIdentifier: string;
  projectId: string;
  projectName: string;
  provider: ModelProvider;
  model: string;
  pricingTier: PricingTier;
  role: ModelRole;
  attempt: number;
  deliveryId: string;
}

export interface WorkerRepository {
  syncLinearState(
    issue: LinearIssue,
    sync: LinearStateSync,
  ): Promise<LinearStateSyncResult>;
  listTaskIds(limit: number): Promise<string[]>;
  claim(
    issue: LinearIssue,
    delivery: {
      deliveryId: string;
      deliveryAttempt: number;
      pubsubMessageId: string;
      subscription: string | null;
    },
    leaseSeconds: number,
    maxDeliveryAttempts: number,
    allowNewClaim: boolean,
  ): Promise<ClaimResult>;
  getCompletedGeneration<T>(generationId: string): Promise<ModelResult<T> | null>;
  startGeneration(context: GenerationContext): Promise<void>;
  completeGeneration<T>(context: GenerationContext, result: ModelResult<T>): Promise<void>;
  failGeneration(
    context: GenerationContext,
    error: Error,
    result?: FailedGenerationResult,
  ): Promise<void>;
  assertWithinBudget(
    taskId: string,
    projectId: string,
    maxTaskMicros: number,
    maxProjectMicros: number,
    maxTaskTokens: number,
    maxSystemMicros: number,
    paidAiCircuitBreakerMicros: number,
    pricingTier: PricingTier,
  ): Promise<void>;
  completeTask(taskId: string, deliveryId: string, status: string, details: object): Promise<void>;
  failTask(taskId: string, deliveryId: string, error: Error): Promise<void>;
}
