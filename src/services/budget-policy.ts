export const DEFAULT_ALERT_THRESHOLDS = [50, 75, 90, 100] as const;

export interface BudgetSources {
  estimatedAiCostMicros: number;
  gatewayActualCostMicros: number;
  gcpCostMicros: number;
  otherCostMicros: number;
}

export interface BudgetSnapshot extends BudgetSources {
  effectiveAiCostMicros: number;
  totalCostMicros: number;
  budgetMicros: number;
  percentageUsed: number;
  remainingMicros: number;
  paused: boolean;
}

export function validMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function sanitizeThresholds(values: readonly number[]): number[] {
  return [...new Set(values)]
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 100)
    .sort((left, right) => left - right);
}

export function calculateBudget(
  sources: BudgetSources,
  budgetMicros: number,
  paused: boolean,
): BudgetSnapshot {
  const effectiveAiCostMicros = Math.max(
    sources.estimatedAiCostMicros,
    sources.gatewayActualCostMicros,
  );
  const totalCostMicros = effectiveAiCostMicros +
    sources.gcpCostMicros + sources.otherCostMicros;
  const safeBudget = Math.max(1, budgetMicros);
  return {
    ...sources,
    effectiveAiCostMicros,
    totalCostMicros,
    budgetMicros: safeBudget,
    percentageUsed: (totalCostMicros / safeBudget) * 100,
    remainingMicros: Math.max(0, safeBudget - totalCostMicros),
    paused,
  };
}

export function crossedThresholds(
  beforePercentage: number,
  afterPercentage: number,
  thresholds: readonly number[],
): number[] {
  return sanitizeThresholds(thresholds).filter(
    (threshold) => beforePercentage < threshold && afterPercentage >= threshold,
  );
}
