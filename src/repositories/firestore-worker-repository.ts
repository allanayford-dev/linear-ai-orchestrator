import { FieldValue, Firestore, Timestamp } from "@google-cloud/firestore";
import type { LinearIssue, ModelResult } from "../types/worker.js";
import type {
  ClaimResult,
  GenerationContext,
  WorkerRepository,
} from "./worker-repository.js";

function monthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function documentPart(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export class FirestoreWorkerRepository implements WorkerRepository {
  constructor(private readonly firestore: Firestore) {}

  async claim(
    issue: LinearIssue,
    deliveryId: string,
    leaseSeconds: number,
    allowNewClaim: boolean,
  ): Promise<ClaimResult> {
    const ref = this.firestore.collection("tasks").doc(issue.id);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.data();
      if (data?.completedDeliveryId === deliveryId) return "duplicate";
      const resumingDelivery = data?.currentDeliveryId === deliveryId;
      if (!allowNewClaim && !resumingDelivery) return "busy";
      const leaseUntil = data?.leaseUntil as Timestamp | undefined;
      if (leaseUntil && leaseUntil.toMillis() > Date.now() && !resumingDelivery) {
        return "busy";
      }
      transaction.set(ref, {
        linearIssueId: issue.id,
        issueIdentifier: issue.identifier,
        title: issue.title,
        projectId: issue.project?.id ?? "unassigned",
        projectName: issue.project?.name ?? "Unassigned",
        orchestrationStatus: "claimed",
        currentDeliveryId: deliveryId,
        leaseUntil: Timestamp.fromMillis(Date.now() + leaseSeconds * 1000),
        claimedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return "claimed";
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
    const generationRef = this.firestore.collection("generations").doc(context.generationId);
    const taskRef = this.firestore.collection("task_usage").doc(context.taskId);
    const month = monthKey();
    const projectRef = this.firestore.collection("project_usage_monthly")
      .doc(`${documentPart(context.projectId)}_${month}`);
    const modelRef = this.firestore.collection("model_usage_monthly")
      .doc(`${documentPart(context.model)}_${month}`);

    await this.firestore.runTransaction(async (transaction) => {
      const [generation, task, project, model] = await Promise.all([
        transaction.get(generationRef),
        transaction.get(taskRef),
        transaction.get(projectRef),
        transaction.get(modelRef),
      ]);
      if (generation.get("status") === "complete") return;
      const usage = result.usage;
      transaction.set(generationRef, {
        ...context,
        status: "complete",
        result,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        estimatedCostMicros: usage.estimatedCostMicros,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      const increment = {
        modelCalls: FieldValue.increment(1),
        inputTokens: FieldValue.increment(usage.inputTokens),
        outputTokens: FieldValue.increment(usage.outputTokens),
        totalTokens: FieldValue.increment(usage.totalTokens),
        estimatedCostMicros: FieldValue.increment(usage.estimatedCostMicros),
        updatedAt: FieldValue.serverTimestamp(),
      };
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
        model: context.model,
        month,
        ...(!model.exists ? { createdAt: FieldValue.serverTimestamp() } : {}),
        ...increment,
      }, { merge: true });
    });
  }

  async failGeneration(generationId: string, error: Error): Promise<void> {
    await this.firestore.collection("generations").doc(generationId).set({
      status: "error",
      errorName: error.name,
      errorMessage: error.message,
      failedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  async assertWithinBudget(taskId: string, projectId: string, maxTaskMicros: number, maxProjectMicros: number): Promise<void> {
    const month = monthKey();
    const [task, project] = await Promise.all([
      this.firestore.collection("task_usage").doc(taskId).get(),
      this.firestore.collection("project_usage_monthly")
        .doc(`${documentPart(projectId)}_${month}`).get(),
    ]);
    const taskCost = (task.get("estimatedCostMicros") as number | undefined) ?? 0;
    const projectCost = (project.get("estimatedCostMicros") as number | undefined) ?? 0;
    if (taskCost >= maxTaskMicros || projectCost >= maxProjectMicros) {
      const error = new Error(
        `Internal AI budget reached (task $${(taskCost / 1_000_000).toFixed(4)}, project $${(projectCost / 1_000_000).toFixed(4)})`,
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
