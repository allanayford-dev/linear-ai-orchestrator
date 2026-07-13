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
  gatewaySync: {
    status: string;
    error: string | null;
    syncedAt: string | null;
    startDate: string | null;
    endDate: string | null;
    requestCount: number;
  };
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

export interface GatewayCostSync {
  gatewayActualCostMicros: number;
  requestCount: number;
  startDate: string;
  endDate: string;
}

export interface DashboardRepository {
  getDashboard(month: string): Promise<DashboardData>;
  updateBudget(update: BudgetUpdate, actor: string): Promise<void>;
  updateExternalCosts(
    month: string,
    update: ExternalCostUpdate,
    actor: string,
  ): Promise<void>;
  syncGatewayCost(month: string, sync: GatewayCostSync): Promise<void>;
  recordGatewaySyncFailure(month: string, error: string): Promise<void>;
}
