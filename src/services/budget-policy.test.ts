import { describe, expect, it } from "vitest";
import {
  calculateBudget,
  crossedThresholds,
  sanitizeThresholds,
  validMonth,
} from "./budget-policy.js";

describe("budget policy", () => {
  it("uses the greater of estimated and actual gateway cost", () => {
    const budget = calculateBudget({
      estimatedAiCostMicros: 3_000_000,
      gatewayActualCostMicros: 4_000_000,
      gcpCostMicros: 2_000_000,
      otherCostMicros: 1_000_000,
    }, 20_000_000, false);

    expect(budget.totalCostMicros).toBe(7_000_000);
    expect(budget.percentageUsed).toBe(35);
    expect(budget.remainingMicros).toBe(13_000_000);
  });

  it("identifies newly crossed thresholds without duplicates", () => {
    expect(crossedThresholds(49, 91, [100, 50, 75, 90, 75])).toEqual([
      50, 75, 90,
    ]);
  });

  it("validates months and thresholds", () => {
    expect(validMonth("2026-07")).toBe(true);
    expect(validMonth("2026-13")).toBe(false);
    expect(sanitizeThresholds([0, 50, 101, 90, 50])).toEqual([50, 90]);
  });
});
