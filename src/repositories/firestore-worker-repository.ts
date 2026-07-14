import { FieldValue, Firestore, Timestamp } from "@google-cloud/firestore";
import type { LinearIssue, ModelResult } from "../types/worker.js";
import type { PricingTier } from "../types/worker.js";
import {
  calculateBudget,
  crossedThresholds,
  DEFAULT_ALERT_THRESHOLDS,
  sanitizeThresholds,
} from "../services/budget-policy.js";
import type {
  ClaimResult,
  FailedGenerationResult,
  GenerationContext,
  LinearStateSync,
  LinearStateSyncResult,
  WorkerRepository,
} from "./worker-repository.js";
import { decideLeaseClaim } from "../services/lease-policy.js";
import {
  linearStateType,
  normalizeLinearState,
} from "../services/linear-state-policy.js";

function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function documentPart(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function usageIncrement(usage: ModelResult<unknown>["usage"]): object {
  return {
    modelCalls: FieldValue.increment(1),
    inputTokens: FieldValue.increment(usage.inputTokens),
    outputTokens: FieldValue.increment(usage.outputTokens),
    reasoningTokens: FieldValue.increment(usage.reasoningTokens),
    totalTokens: FieldValue.increment(usage.totalTokens),
    estimatedCostMicros: FieldValue.increment(usage.estimatedCostMicros),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export class FirestoreWorkerRepository implements WorkerRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly defaultSystemBudgetMicros = 20_000_000,
    private readonly defaultPaidAiCircuitBreakerMicros = 18_000_000,
  ) {}

  async syncLinearState(
    issue: LinearIssue,
    sync: LinearStateSync,
  ): Promise<LinearStateSyncResult> {
    const taskRef = this.firestore.collection("tasks").doc(issue.id);
    const auditRef = this.firestore.collection("task_state_transitions")
      .doc(documentPart(`${issue.id}:${sync.deliveryId}`));

    return this.firestore.runTransaction(async (transaction) => {
      const [task, audit] = await Promise.all([
        transaction.get(taskRef),
        transaction.get(auditRef),
      ]);
      const taskData = task.data() ?? {};
      const resumeCurrentDelivery =
        taskData.currentDeliveryId === sync.deliveryId;
      if (audit.exists) {
        return { outcome: "duplicate", resumeCurrentDelivery };
      }

      const stateType = linearStateType(issue);
      const normalized = normalizeLinearState(issue.state.name);
      const previousTimestamp = typeof taskData.linearStateEventTimestamp === "number"
        ? taskData.linearStateEventTimestamp
        : 0;
      const stale = sync.source === "linear-webhook" &&
        previousTimestamp > sync.eventTimestamp;
      const unchanged =
        taskData.currentLinearStateId === issue.state.id &&
        taskData.currentLinearStateName === issue.state.name &&
        taskData.currentLinearStateType === stateType;
      const outcome = stale ? "stale" : unchanged ? "unchanged" : "updated";

      if (!stale) {
        transaction.set(taskRef, {
          linearIssueId: issue.id,
          issueIdentifier: issue.identifier,
          title: issue.title,
          projectId: issue.project?.id ?? "unassigned",
          projectName: issue.project?.name ?? "Unassigned",
          currentLinearStateId: issue.state.id,
          currentLinearStateName: issue.state.name,
          currentLinearStateType: stateType,
          currentLinearStateNormalized: normalized,
          linearStateEventTimestamp: sync.eventTimestamp,
          linearStateDeliveryId: sync.deliveryId,
          linearStateSyncSource: sync.source,
          linearStateUpdatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      transaction.create(auditRef, {
        taskId: issue.id,
        issueIdentifier: issue.identifier,
        deliveryId: sync.deliveryId,
        source: sync.source,
        eventTimestamp: sync.eventTimestamp,
        outcome,
        previousStateId: taskData.currentLinearStateId ?? null,
        previousStateName: taskData.currentLinearStateName ?? null,
        previousStateType: taskData.currentLinearStateType ?? null,
        currentStateId: issue.state.id,
        currentStateName: issue.state.name,
        currentStateType: stateType,
        currentStateNormalized: normalized,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { outcome, resumeCurrentDelivery };
    });
  }

  async listTaskIds(limit: number): Promise<string[]> {
    const snapshot = await this.firestore.collection("tasks")
      .orderBy("updatedAt", "desc")
      .limit(limit)
      .get();
    return snapshot.docs.map((document) => document.id);
  }

  private async recordGenerationUsage(
    context: GenerationContext,
    result: FailedGenerationResult,
    generationFields: object,
    skipCompleted: boolean,
  ): Promise<void> {
    const generationRef = this.firestore.collection("generations")
      .doc(context.generationId);
    const taskRef = this.firestore.collection("task_usage").doc(context.taskId);
    const month = monthKey();
    const projectRef = this.firestore.collection("project_usage_monthly")
      .doc(`${documentPart(context.projectId)}_${month}`);
    const modelRef = this.firestore.collection("model_usage_monthly")
      .doc(`${documentPart(`${context.provider}:${context.model}`)}_${month}`);
    const systemRef = this.firestore.collection("system_usage_monthly").doc(month);
    const externalRef = this.firestore.collection("external_costs_monthly").doc(month);
    const controlRef = this.firestore.collection("orchestrator_control").doc("global");

    await this.firestore.runTransaction(async (transaction) => {
      const [generation, task, project, model, system, external, control] =
        await Promise.all([
        transaction.get(generationRef),
        transaction.get(taskRef),
        transaction.get(projectRef),
        transaction.get(modelRef),
        transaction.get(systemRef),
        transaction.get(externalRef),
        transaction.get(controlRef),
      ]);
      if (skipCompleted && generation.get("status") === "complete") return;

      const usage = result.usage;
      const usageAlreadyCounted = generation.get("usageCounted") === true;
      transaction.set(generationRef, {
        ...context,
        ...generationFields,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
        estimatedCostMicros: usage.estimatedCostMicros,
        costSource: usage.costSource ?? "unknown",
        usageCounted: true,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (usageAlreadyCounted) return;

      const increment = usageIncrement(usage);
      transaction.set(taskRef, {
        taskId: context.taskId,
        issueIdentifier: context.issueIdentifier,
        projectId: context.projectId,
        ...(!task.exists ? { createdAt: FieldValue.serverTimestamp() } : {}),
        ...increment,
      }, { merge: true });
      transaction.set(projectRef, {
        projectId: context.projectId,
        projectName: context.projectName,
        month,
        ...(!project.exists ? { createdAt: FieldValue.serverTimestamp() } : {}),
        ...increment,
      }, { merge: true });
      transaction.set(modelRef, {
        provider: context.provider,
        model: context.model,
        pricingTier: context.pricingTier,
        month,
        ...(!model.exists ? { createdAt: FieldValue.serverTimestamp() } : {}),
        ...increment,
      }, { merge: true });
      transaction.set(systemRef, {
        month,
        ...(!system.exists ? { createdAt: FieldValue.serverTimestamp() } : {}),
        ...increment,
      }, { merge: true });

      const budgetMicros = (control.get("budgetMicros") as number | undefined) ??
        this.defaultSystemBudgetMicros;
      const paidAiCircuitBreakerMicros =
        (control.get("paidAiCircuitBreakerMicros") as number | undefined) ??
        Math.min(this.defaultPaidAiCircuitBreakerMicros, budgetMicros);
      const thresholds = sanitizeThresholds(
        (control.get("thresholds") as number[] | undefined) ??
          DEFAULT_ALERT_THRESHOLDS,
      );
      const estimatedBefore =
        (system.get("estimatedCostMicros") as number | undefined) ?? 0;
      const sources = {
        gatewayActualCostMicros:
          (external.get("gatewayActualCostMicros") as number | undefined) ?? 0,
        gcpCostMicros:
          (external.get("gcpCostMicros") as number | undefined) ?? 0,
        otherCostMicros:
          (external.get("otherCostMicros") as number | undefined) ?? 0,
      };
      const before = calculateBudget({
        estimatedAiCostMicros: estimatedBefore,
        ...sources,
      }, budgetMicros, control.get("paused") === true);
      const after = calculateBudget({
        estimatedAiCostMicros: estimatedBefore + usage.estimatedCostMicros,
        ...sources,
      }, budgetMicros, control.get("paused") === true);
      for (const threshold of crossedThresholds(
        before.percentageUsed,
        after.percentageUsed,
        thresholds,
      )) {
        transaction.set(
          this.firestore.collection("budget_alerts").doc(`${month}_${threshold}`),
          {
            month,
            threshold,
            totalCostMicros: after.totalCostMicros,
            budgetMicros,
            source: "model-usage",
            issueIdentifier: context.issueIdentifier,
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
      if (after.totalCostMicros >= budgetMicros) {
        transaction.set(controlRef, {
          paused: true,
          pauseReason:
            `Monthly $${(budgetMicros / 1_000_000).toFixed(2)} limit reached`,
          pausedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } else if (
        context.pricingTier === "paid" &&
        after.totalCostMicros >= paidAiCircuitBreakerMicros
      ) {
        transaction.set(controlRef, {
          paidAiPaused: true,
          paidAiPauseReason:
            `Paid AI safety limit of $${(paidAiCircuitBreakerMicros / 1_000_000).toFixed(2)} reached`,
          paidAiPausedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });
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
    const ref = this.firestore.collection("tasks").doc(issue.id);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.data();
      const leaseUntil = data?.leaseUntil as Timestamp | undefined;
      const decision = decideLeaseClaim({
        ...(typeof data?.completedDeliveryId === "string"
          ? { completedDeliveryId: data.completedDeliveryId }
          : {}),
        ...(typeof data?.currentDeliveryId === "string"
          ? { currentDeliveryId: data.currentDeliveryId }
          : {}),
        ...(leaseUntil ? { leaseUntilMs: leaseUntil.toMillis() } : {}),
        ...(typeof data?.orchestrationStatus === "string"
          ? { orchestrationStatus: data.orchestrationStatus }
          : {}),
      }, {
        deliveryId: delivery.deliveryId,
        deliveryAttempt: delivery.deliveryAttempt,
        maxDeliveryAttempts,
        allowNewClaim,
        nowMs: Date.now(),
      });
      if (decision === "duplicate" || decision === "busy") return decision;
      if (decision === "delivery_limit") {
        transaction.set(ref, {
          linearIssueId: issue.id,
          issueIdentifier: issue.identifier,
          title: issue.title,
          orchestrationStatus: "delivery_limit_reached",
          currentDeliveryId: delivery.deliveryId,
          deliveryAttempt: delivery.deliveryAttempt,
          pubsubMessageId: delivery.pubsubMessageId,
          deliverySubscription: delivery.subscription,
          configuredDeliveryLimit: maxDeliveryAttempts,
          leaseUntil: FieldValue.delete(),
          deliveryLimitReachedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return decision;
      }
      transaction.set(ref, {
        linearIssueId: issue.id,
        issueIdentifier: issue.identifier,
        title: issue.title,
        projectId: issue.project?.id ?? "unassigned",
        projectName: issue.project?.name ?? "Unassigned",
        orchestrationStatus: decision === "recovered" ? "stale_recovered" : "claimed",
        currentDeliveryId: delivery.deliveryId,
        deliveryAttempt: delivery.deliveryAttempt,
        pubsubMessageId: delivery.pubsubMessageId,
        deliverySubscription: delivery.subscription,
        leaseUntil: Timestamp.fromMillis(Date.now() + leaseSeconds * 1000),
        claimedAt: FieldValue.serverTimestamp(),
        ...(decision === "recovered" ? {
          recoveryCount: FieldValue.increment(1),
          previousDeliveryId: data?.currentDeliveryId ?? null,
          recoveredAt: FieldValue.serverTimestamp(),
        } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return decision;
    });
  }

  async getCompletedGeneration<T>(generationId: string): Promise<ModelResult<T> | null> {
    const snapshot = await this.firestore.collection("generations").doc(generationId).get();
    if (!snapshot.exists || snapshot.get("status") !== "complete") return null;
    return snapshot.get("result") as ModelResult<T>;
  }

  async startGeneration(context: GenerationContext): Promise<void> {
    await this.firestore.collection("generations").doc(context.generationId).set({
      ...context,
      status: "pending",
      attemptCount: FieldValue.increment(1),
      startedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  async completeGeneration<T>(context: GenerationContext, result: ModelResult<T>): Promise<void> {
    await this.recordGenerationUsage(
      context,
      result,
      {
        status: "complete",
        result,
        completedAt: FieldValue.serverTimestamp(),
      },
      true,
    );
  }

  async failGeneration(
    context: GenerationContext,
    error: Error,
    result?: FailedGenerationResult,
  ): Promise<void> {
    const generationRef = this.firestore.collection("generations")
      .doc(context.generationId);
    if (!result) {
      await generationRef.set({
        status: "error",
        errorName: error.name,
        errorMessage: error.message,
        failedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return;
    }

    await this.recordGenerationUsage(
      context,
      result,
      {
        status: "error",
        errorName: error.name,
        errorMessage: error.message,
        failedResult: result,
        failedAt: FieldValue.serverTimestamp(),
      },
      false,
    );
  }

  async assertWithinBudget(
    taskId: string,
    projectId: string,
    maxTaskMicros: number,
    maxProjectMicros: number,
    maxTaskTokens: number,
    maxSystemMicros: number,
    paidAiCircuitBreakerMicros: number,
    pricingTier: PricingTier,
  ): Promise<void> {
    const month = monthKey();
    const [task, project, system, external, control] = await Promise.all([
      this.firestore.collection("task_usage").doc(taskId).get(),
      this.firestore.collection("project_usage_monthly")
        .doc(`${documentPart(projectId)}_${month}`).get(),
      this.firestore.collection("system_usage_monthly").doc(month).get(),
      this.firestore.collection("external_costs_monthly").doc(month).get(),
      this.firestore.collection("orchestrator_control").doc("global").get(),
    ]);
    const taskCost = (task.get("estimatedCostMicros") as number | undefined) ?? 0;
    const taskTokens = (task.get("totalTokens") as number | undefined) ?? 0;
    const projectCost = (project.get("estimatedCostMicros") as number | undefined) ?? 0;
    const budgetMicros = (control.get("budgetMicros") as number | undefined) ??
      maxSystemMicros;
    const paidLimit =
      (control.get("paidAiCircuitBreakerMicros") as number | undefined) ??
      paidAiCircuitBreakerMicros;
    const systemBudget = calculateBudget({
      estimatedAiCostMicros:
        (system.get("estimatedCostMicros") as number | undefined) ?? 0,
      gatewayActualCostMicros:
        (external.get("gatewayActualCostMicros") as number | undefined) ?? 0,
      gcpCostMicros: (external.get("gcpCostMicros") as number | undefined) ?? 0,
      otherCostMicros: (external.get("otherCostMicros") as number | undefined) ?? 0,
    }, budgetMicros, control.get("paused") === true);
    if (
      systemBudget.paused ||
      systemBudget.totalCostMicros >= systemBudget.budgetMicros ||
      (pricingTier === "paid" && (
        control.get("paidAiPaused") === true ||
        systemBudget.totalCostMicros >= paidLimit
      )) ||
      taskCost >= maxTaskMicros ||
      projectCost >= maxProjectMicros ||
      taskTokens >= maxTaskTokens
    ) {
      const error = new Error(
        `Internal budget reached (system $${(systemBudget.totalCostMicros / 1_000_000).toFixed(4)} of $${(systemBudget.budgetMicros / 1_000_000).toFixed(2)}, paid AI stop $${(paidLimit / 1_000_000).toFixed(2)}, task $${(taskCost / 1_000_000).toFixed(4)}, project $${(projectCost / 1_000_000).toFixed(4)}, task tokens ${taskTokens})`,
      );
      error.name = "BudgetExceededError";
      throw error;
    }
  }

  async completeTask(taskId: string, deliveryId: string, status: string, details: object): Promise<void> {
    await this.firestore.collection("tasks").doc(taskId).set({
      orchestrationStatus: status,
      completedDeliveryId: deliveryId,
      leaseUntil: FieldValue.delete(),
      ...details,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  async failTask(taskId: string, deliveryId: string, error: Error): Promise<void> {
    await this.firestore.collection("tasks").doc(taskId).set({
      orchestrationStatus: "retryable_error",
      currentDeliveryId: deliveryId,
      leaseUntil: FieldValue.delete(),
      lastErrorName: error.name,
      lastErrorMessage: error.message,
      failedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
}
