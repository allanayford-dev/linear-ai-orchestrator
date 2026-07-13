import {
  FieldValue,
  Firestore,
  Timestamp,
  type QuerySnapshot,
} from "@google-cloud/firestore";
import {
  calculateBudget,
  crossedThresholds,
  sanitizeThresholds,
} from "../services/budget-policy.js";
import type {
  BudgetUpdate,
  DashboardData,
  DashboardRecord,
  DashboardRepository,
  ExternalCostUpdate,
  GatewayCostSync,
} from "./dashboard-repository.js";

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function serializable(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializable(item)]),
    );
  }
  return value;
}

function records(snapshot: QuerySnapshot): DashboardRecord[] {
  return snapshot.docs.map((document) => ({
    id: document.id,
    ...(serializable(document.data()) as Record<string, unknown>),
  }));
}

export class FirestoreDashboardRepository implements DashboardRepository {
  constructor(
    private readonly firestore: Firestore,
    private readonly defaultBudgetMicros: number,
    private readonly defaultThresholds: readonly number[],
  ) {}

  async getDashboard(month: string): Promise<DashboardData> {
    const [system, external, control, tasks, generations, projects, models, alerts] =
      await Promise.all([
        this.firestore.collection("system_usage_monthly").doc(month).get(),
        this.firestore.collection("external_costs_monthly").doc(month).get(),
        this.firestore.collection("orchestrator_control").doc("global").get(),
        this.firestore.collection("tasks").orderBy("updatedAt", "desc").limit(100).get(),
        this.firestore.collection("generations").orderBy("updatedAt", "desc").limit(100).get(),
        this.firestore.collection("project_usage_monthly").where("month", "==", month).get(),
        this.firestore.collection("model_usage_monthly").where("month", "==", month).get(),
        this.firestore.collection("budget_alerts").where("month", "==", month).get(),
      ]);

    const budgetMicros = numberValue(control.get("budgetMicros")) ||
      this.defaultBudgetMicros;
    const configuredThresholds = control.get("thresholds");
    const thresholds = sanitizeThresholds(
      Array.isArray(configuredThresholds)
        ? configuredThresholds.filter((value): value is number => typeof value === "number")
        : this.defaultThresholds,
    );
    const budget = calculateBudget({
      estimatedAiCostMicros: numberValue(system.get("estimatedCostMicros")),
      gatewayActualCostMicros: numberValue(external.get("gatewayActualCostMicros")),
      gcpCostMicros: numberValue(external.get("gcpCostMicros")),
      otherCostMicros: numberValue(external.get("otherCostMicros")),
    }, budgetMicros, control.get("paused") === true);

    return {
      month,
      budget,
      paidAiCircuitBreakerMicros:
        numberValue(control.get("paidAiCircuitBreakerMicros")) ||
        Math.min(18_000_000, budgetMicros),
      paidAiPaused: control.get("paidAiPaused") === true,
      gatewaySync: {
        status: typeof external.get("gatewaySyncStatus") === "string"
          ? external.get("gatewaySyncStatus") as string
          : "manual",
        error: typeof external.get("gatewaySyncError") === "string"
          ? external.get("gatewaySyncError") as string
          : null,
        syncedAt: external.get("gatewaySyncedAt") instanceof Timestamp
          ? (external.get("gatewaySyncedAt") as Timestamp).toDate().toISOString()
          : null,
        startDate: typeof external.get("gatewaySyncStartDate") === "string"
          ? external.get("gatewaySyncStartDate") as string
          : null,
        endDate: typeof external.get("gatewaySyncEndDate") === "string"
          ? external.get("gatewaySyncEndDate") as string
          : null,
        requestCount: numberValue(external.get("gatewaySyncRequestCount")),
      },
      thresholds,
      tasks: records(tasks),
      generations: records(generations),
      projects: records(projects),
      models: records(models),
      alerts: records(alerts).sort((left, right) =>
        numberValue(right.threshold) - numberValue(left.threshold)),
    };
  }

  async updateBudget(update: BudgetUpdate, actor: string): Promise<void> {
    await this.firestore.collection("orchestrator_control").doc("global").set({
      budgetMicros: update.budgetMicros,
      paidAiCircuitBreakerMicros: update.paidAiCircuitBreakerMicros,
      thresholds: sanitizeThresholds(update.thresholds),
      paused: update.paused,
      paidAiPaused: update.paused ? true : false,
      paidAiPauseReason: update.paused
        ? update.pauseReason || "Paused manually from the dashboard"
        : FieldValue.delete(),
      pauseReason: update.paused
        ? update.pauseReason || "Paused manually from the dashboard"
        : FieldValue.delete(),
      updatedBy: actor,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  async updateExternalCosts(
    month: string,
    update: ExternalCostUpdate,
    actor: string,
  ): Promise<void> {
    await this.writeExternalCosts(month, update, actor);
  }

  async syncGatewayCost(month: string, sync: GatewayCostSync): Promise<void> {
    await this.writeExternalCosts(
      month,
      { gatewayActualCostMicros: sync.gatewayActualCostMicros },
      "vercel-report-api",
      {
        gatewaySyncStatus: "ok",
        gatewaySyncError: FieldValue.delete(),
        gatewaySyncStartDate: sync.startDate,
        gatewaySyncEndDate: sync.endDate,
        gatewaySyncRequestCount: sync.requestCount,
        gatewaySyncedAt: FieldValue.serverTimestamp(),
      },
    );
  }

  async recordGatewaySyncFailure(month: string, error: string): Promise<void> {
    await this.firestore.collection("external_costs_monthly").doc(month).set({
      month,
      gatewaySyncStatus: "error",
      gatewaySyncError: error.slice(0, 500),
      gatewaySyncFailedAt: FieldValue.serverTimestamp(),
      updatedBy: "vercel-report-api",
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  private async writeExternalCosts(
    month: string,
    update: Partial<ExternalCostUpdate>,
    actor: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const externalRef = this.firestore.collection("external_costs_monthly").doc(month);
    const systemRef = this.firestore.collection("system_usage_monthly").doc(month);
    const controlRef = this.firestore.collection("orchestrator_control").doc("global");

    await this.firestore.runTransaction(async (transaction) => {
      const [system, external, control] = await Promise.all([
        transaction.get(systemRef),
        transaction.get(externalRef),
        transaction.get(controlRef),
      ]);
      const budgetMicros = numberValue(control.get("budgetMicros")) ||
        this.defaultBudgetMicros;
      const paidAiCircuitBreakerMicros =
        numberValue(control.get("paidAiCircuitBreakerMicros")) ||
        Math.min(18_000_000, budgetMicros);
      const thresholds = sanitizeThresholds(
        Array.isArray(control.get("thresholds"))
          ? control.get("thresholds") as number[]
          : this.defaultThresholds,
      );
      const before = calculateBudget({
        estimatedAiCostMicros: numberValue(system.get("estimatedCostMicros")),
        gatewayActualCostMicros: numberValue(external.get("gatewayActualCostMicros")),
        gcpCostMicros: numberValue(external.get("gcpCostMicros")),
        otherCostMicros: numberValue(external.get("otherCostMicros")),
      }, budgetMicros, control.get("paused") === true);
      const completeUpdate: ExternalCostUpdate = {
        gatewayActualCostMicros: update.gatewayActualCostMicros ??
          numberValue(external.get("gatewayActualCostMicros")),
        gcpCostMicros: update.gcpCostMicros ??
          numberValue(external.get("gcpCostMicros")),
        otherCostMicros: update.otherCostMicros ??
          numberValue(external.get("otherCostMicros")),
      };
      const after = calculateBudget({
        estimatedAiCostMicros: numberValue(system.get("estimatedCostMicros")),
        ...completeUpdate,
      }, budgetMicros, control.get("paused") === true);

      transaction.set(externalRef, {
        month,
        ...completeUpdate,
        ...metadata,
        updatedBy: actor,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
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
            source: "external-cost-update",
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
          updatedBy: actor,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } else if (after.totalCostMicros >= paidAiCircuitBreakerMicros) {
        transaction.set(controlRef, {
          paidAiPaused: true,
          paidAiPauseReason:
            `Paid AI safety limit of $${(paidAiCircuitBreakerMicros / 1_000_000).toFixed(2)} reached`,
          paidAiPausedAt: FieldValue.serverTimestamp(),
          updatedBy: actor,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });
  }
}
