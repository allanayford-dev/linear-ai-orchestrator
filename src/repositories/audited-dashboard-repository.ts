import { FieldValue, Firestore } from "@google-cloud/firestore";
import { randomUUID } from "node:crypto";
import type {
  BudgetUpdate,
  DashboardData,
  DashboardRepository,
  ExternalCostUpdate,
} from "./dashboard-repository.js";

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function thresholds(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

/**
 * Adds durable audit evidence around manual budget-control changes without
 * changing the existing dashboard repository implementation.
 */
export class AuditedDashboardRepository implements DashboardRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly inner: DashboardRepository,
  ) {}

  getDashboard(month: string): Promise<DashboardData> {
    return this.inner.getDashboard(month);
  }

  async updateBudget(update: BudgetUpdate, actor: string): Promise<void> {
    const controlRef = this.firestore.collection("orchestrator_control").doc("global");
    const before = await controlRef.get();
    const previousPaused = before.get("paused") === true;
    const previousPaidAiPaused = before.get("paidAiPaused") === true;
    const action = update.paused && !previousPaused
      ? "pause"
      : !update.paused && (previousPaused || previousPaidAiPaused)
        ? "resume"
        : "settings_update";
    const auditRef = this.firestore
      .collection("orchestrator_control_audit")
      .doc(randomUUID());

    await auditRef.set({
      action,
      actor,
      status: "pending",
      previousPaused,
      previousPaidAiPaused,
      requestedPaused: update.paused,
      previousBudgetMicros: numberValue(before.get("budgetMicros")),
      budgetMicros: update.budgetMicros,
      previousPaidAiCircuitBreakerMicros: numberValue(
        before.get("paidAiCircuitBreakerMicros"),
      ),
      paidAiCircuitBreakerMicros: update.paidAiCircuitBreakerMicros,
      previousThresholds: thresholds(before.get("thresholds")),
      thresholds: update.thresholds,
      pauseReason: update.pauseReason ?? null,
      createdAt: FieldValue.serverTimestamp(),
    });

    try {
      await this.inner.updateBudget(update, actor);
      await auditRef.set({
        status: "complete",
        completedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (error) {
      await auditRef.set({
        status: "error",
        errorName: error instanceof Error ? error.name : "Error",
        errorMessage: error instanceof Error ? error.message : String(error),
        failedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      throw error;
    }
  }

  updateExternalCosts(
    month: string,
    update: ExternalCostUpdate,
    actor: string,
  ): Promise<void> {
    return this.inner.updateExternalCosts(month, update, actor);
  }
}
