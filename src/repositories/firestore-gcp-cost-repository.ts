import { FieldValue, Firestore } from "@google-cloud/firestore";
import {
  calculateBudget,
  crossedThresholds,
  DEFAULT_ALERT_THRESHOLDS,
  sanitizeThresholds,
} from "../services/budget-policy.js";
import type {
  GcpCostReconciliation,
  GcpCostRepository,
} from "./gcp-cost-repository.js";

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class FirestoreGcpCostRepository implements GcpCostRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly defaultBudgetMicros: number,
    private readonly defaultPaidLimitMicros: number,
  ) {}

  async complete(item: GcpCostReconciliation): Promise<void> {
    const externalRef = this.firestore.collection("external_costs_monthly").doc(item.month);
    const systemRef = this.firestore.collection("system_usage_monthly").doc(item.month);
    const controlRef = this.firestore.collection("orchestrator_control").doc("global");
    const auditRef = this.firestore.collection("cost_reconciliations").doc(item.attemptId);

    await this.firestore.runTransaction(async (transaction) => {
      const [external, system, control] = await Promise.all([
        transaction.get(externalRef),
        transaction.get(systemRef),
        transaction.get(controlRef),
      ]);
      const budgetMicros = number(control.get("budgetMicros")) ||
        this.defaultBudgetMicros;
      const paidLimitMicros = number(control.get("paidAiCircuitBreakerMicros")) ||
        Math.min(this.defaultPaidLimitMicros, budgetMicros);
      const thresholds = sanitizeThresholds(
        Array.isArray(control.get("thresholds"))
          ? control.get("thresholds") as number[]
          : DEFAULT_ALERT_THRESHOLDS,
      );
      const common = {
        estimatedAiCostMicros: number(system.get("estimatedCostMicros")),
        gatewayActualCostMicros: number(external.get("gatewayActualCostMicros")),
        otherCostMicros: number(external.get("otherCostMicros")),
      };
      const before = calculateBudget({
        ...common,
        gcpCostMicros: number(external.get("gcpCostMicros")),
      }, budgetMicros, control.get("paused") === true);
      const after = calculateBudget({
        ...common,
        gcpCostMicros: item.costMicros,
      }, budgetMicros, control.get("paused") === true);

      transaction.set(externalRef, {
        month: item.month,
        gcpCostMicros: item.costMicros,
        gcpCostCurrency: item.currency,
        gcpCostSource: "bigquery-standard-export",
        gcpCostStatus: "fresh",
        gcpCostRowCount: item.rowCount,
        gcpCostTable: item.table,
        gcpCostProjectId: item.projectId,
        gcpCostQueryStart: item.queryStart,
        gcpCostQueryEnd: item.queryEnd,
        gcpCostError: FieldValue.delete(),
        gcpCostUpdatedAt: FieldValue.serverTimestamp(),
        gcpCostAttemptedAt: FieldValue.serverTimestamp(),
        updatedBy: "orchestrator-worker",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(auditRef, {
        ...item,
        provider: "google-cloud",
        source: "bigquery-standard-export",
        actor: "orchestrator-worker",
        trigger: "authenticated-http",
        status: "complete",
        createdAt: FieldValue.serverTimestamp(),
      });

      for (const threshold of crossedThresholds(
        before.percentageUsed,
        after.percentageUsed,
        thresholds,
      )) {
        transaction.set(
          this.firestore.collection("budget_alerts").doc(`${item.month}_${threshold}`),
          {
            month: item.month,
            threshold,
            totalCostMicros: after.totalCostMicros,
            budgetMicros,
            source: "gcp-billing-reconciliation",
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
      if (after.totalCostMicros >= budgetMicros) {
        transaction.set(controlRef, {
          paused: true,
          pauseReason: `Monthly $${(budgetMicros / 1_000_000).toFixed(2)} limit reached`,
          pausedAt: FieldValue.serverTimestamp(),
          updatedBy: "gcp-billing-reconciliation",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } else if (after.totalCostMicros >= paidLimitMicros) {
        transaction.set(controlRef, {
          paidAiPaused: true,
          paidAiPauseReason:
            `Paid AI safety limit of $${(paidLimitMicros / 1_000_000).toFixed(2)} reached`,
          paidAiPausedAt: FieldValue.serverTimestamp(),
          updatedBy: "gcp-billing-reconciliation",
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });
  }

  async fail(
    attemptId: string,
    month: string,
    table: string,
    projectId: string,
    error: Error,
  ): Promise<void> {
    const batch = this.firestore.batch();
    batch.set(this.firestore.collection("external_costs_monthly").doc(month), {
      month,
      gcpCostStatus: "error",
      gcpCostError: error.message.slice(0, 1000),
      gcpCostAttemptedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    batch.create(this.firestore.collection("cost_reconciliations").doc(attemptId), {
      attemptId,
      month,
      table,
      projectId,
      provider: "google-cloud",
      source: "bigquery-standard-export",
      actor: "orchestrator-worker",
      trigger: "authenticated-http",
      status: "error",
      errorName: error.name,
      errorMessage: error.message.slice(0, 1000),
      createdAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();
  }
}
