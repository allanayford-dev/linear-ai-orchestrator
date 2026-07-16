import { Firestore } from "@google-cloud/firestore";
import type {
  ClaimResult,
  FailedGenerationResult,
  GenerationContext,
  LinearStateSync,
  LinearStateSyncResult,
  WorkerRepository,
} from "./worker-repository.js";
import type { LinearIssue, ModelResult, PricingTier } from "../types/worker.js";

/**
 * Prevents new Todo claims while the global manual pause is enabled.
 *
 * Webhook/state synchronization still happens in OrchestratorWorkerService before
 * claim() is called, so intake remains available while execution is paused.
 * Existing In Progress deliveries may still resume because allowNewClaim=false.
 */
export class PauseAwareWorkerRepository implements WorkerRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly inner: WorkerRepository,
  ) {}

  syncLinearState(
    issue: LinearIssue,
    sync: LinearStateSync,
  ): Promise<LinearStateSyncResult> {
    return this.inner.syncLinearState(issue, sync);
  }

  listTaskIds(limit: number): Promise<string[]> {
    return this.inner.listTaskIds(limit);
  }

  async claim(
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
  ): Promise<ClaimResult> {
    if (allowNewClaim) {
      const control = await this.firestore
        .collection("orchestrator_control")
        .doc("global")
        .get();
      if (control.get("paused") === true) {
        return "busy";
      }
    }

    return this.inner.claim(
      issue,
      delivery,
      leaseSeconds,
      maxDeliveryAttempts,
      allowNewClaim,
    );
  }

  getCompletedGeneration<T>(generationId: string): Promise<ModelResult<T> | null> {
    return this.inner.getCompletedGeneration<T>(generationId);
  }

  startGeneration(context: GenerationContext): Promise<void> {
    return this.inner.startGeneration(context);
  }

  completeGeneration<T>(
    context: GenerationContext,
    result: ModelResult<T>,
  ): Promise<void> {
    return this.inner.completeGeneration(context, result);
  }

  failGeneration(
    context: GenerationContext,
    error: Error,
    result?: FailedGenerationResult,
  ): Promise<void> {
    return this.inner.failGeneration(context, error, result);
  }

  assertWithinBudget(
    taskId: string,
    projectId: string,
    maxTaskMicros: number,
    maxProjectMicros: number,
    maxTaskTokens: number,
    maxSystemMicros: number,
    paidAiCircuitBreakerMicros: number,
    pricingTier: PricingTier,
  ): Promise<void> {
    return this.inner.assertWithinBudget(
      taskId,
      projectId,
      maxTaskMicros,
      maxProjectMicros,
      maxTaskTokens,
      maxSystemMicros,
      paidAiCircuitBreakerMicros,
      pricingTier,
    );
  }

  completeTask(
    taskId: string,
    deliveryId: string,
    status: string,
    details: object,
  ): Promise<void> {
    return this.inner.completeTask(taskId, deliveryId, status, details);
  }

  failTask(taskId: string, deliveryId: string, error: Error): Promise<void> {
    return this.inner.failTask(taskId, deliveryId, error);
  }
}
