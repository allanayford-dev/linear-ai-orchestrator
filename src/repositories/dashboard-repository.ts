import type { BudgetSnapshot } from "../services/budget-policy.js";

export interface DashboardRecord {
  id: string;
  [key: string]: unknown;
}

export interface DashboardData {
  month: string;
  budget: BudgetSnapshot;
  paidAiCircuitBreakerMicros: number;
  paidAiPaused: boolean;
  thresholds: number[];
  tasks: DashboardRecord[];
  generations: DashboardRecord[];
  projects: DashboardRecord[];
  models: DashboardRecord[];
  alerts: DashboardRecord[];
}

export interface BudgetUpdate {
  budgetMicros: number;
  paidAiCircuitBreakerMicros: number;
  thresholds: number[];
  paused: boolean;
  pauseReason?: string;
}

export interface ExternalCostUpdate {
  gatewayActualCostMicros: number;
  gcpCostMicros: number;
  otherCostMicros: number;
}

export interface DashboardRepository {
  getDashboard(month: string): Promise<DashboardData>;
  updateBudget(update: BudgetUpdate, actor: string): Promise<void>;
  updateExternalCosts(
    month: string,
    update: ExternalCostUpdate,
    actor: string,
  ): Promise<void>;
}
