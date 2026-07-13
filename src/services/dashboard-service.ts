import { sanitizeThresholds, validMonth } from "./budget-policy.js";
import type {
  BudgetUpdate,
  DashboardRepository,
  ExternalCostUpdate,
} from "../repositories/dashboard-repository.js";

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value as number;
}

export class DashboardService {
  constructor(private readonly repository: DashboardRepository) {}

  getDashboard(month: string) {
    if (!validMonth(month)) throw new Error("month must use YYYY-MM format");
    return this.repository.getDashboard(month);
  }

  async updateBudget(input: unknown, actor: string): Promise<void> {
    if (!input || typeof input !== "object") throw new Error("Budget body is required");
    const body = input as Record<string, unknown>;
    const thresholds = Array.isArray(body.thresholds)
      ? body.thresholds.filter((value): value is number => typeof value === "number")
      : [];
    const update: BudgetUpdate = {
      budgetMicros: nonNegativeInteger(body.budgetMicros, "budgetMicros"),
      paidAiCircuitBreakerMicros: nonNegativeInteger(
        body.paidAiCircuitBreakerMicros,
        "paidAiCircuitBreakerMicros",
      ),
      thresholds: sanitizeThresholds(thresholds),
      paused: body.paused === true,
      ...(typeof body.pauseReason === "string"
        ? { pauseReason: body.pauseReason.slice(0, 500) }
        : {}),
    };
    if (update.budgetMicros === 0) throw new Error("budgetMicros must be greater than zero");
    if (update.paidAiCircuitBreakerMicros === 0) {
      throw new Error("paidAiCircuitBreakerMicros must be greater than zero");
    }
    if (update.paidAiCircuitBreakerMicros > update.budgetMicros) {
      throw new Error("Paid AI safety limit cannot exceed the monthly total limit");
    }
    if (update.thresholds.length === 0) throw new Error("At least one alert threshold is required");
    await this.repository.updateBudget(update, actor);
  }

  async updateExternalCosts(
    month: string,
    input: unknown,
    actor: string,
  ): Promise<void> {
    if (!validMonth(month)) throw new Error("month must use YYYY-MM format");
    if (!input || typeof input !== "object") throw new Error("Cost body is required");
    const body = input as Record<string, unknown>;
    const update: ExternalCostUpdate = {
      gatewayActualCostMicros: nonNegativeInteger(
        body.gatewayActualCostMicros,
        "gatewayActualCostMicros",
      ),
      gcpCostMicros: nonNegativeInteger(body.gcpCostMicros, "gcpCostMicros"),
      otherCostMicros: nonNegativeInteger(body.otherCostMicros, "otherCostMicros"),
    };
    await this.repository.updateExternalCosts(month, update, actor);
  }
}
