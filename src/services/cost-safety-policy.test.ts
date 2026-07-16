import { describe, expect, it } from "vitest";
import {
  calculateBudget,
  crossedThresholds,
  DEFAULT_ALERT_THRESHOLDS,
} from "./budget-policy.js";

const MONTHLY_TARGET_MICROS = 20_000_000;

function percentageAt(totalCostMicros: number): number {
  return calculateBudget({
    estimatedAiCostMicros: totalCostMicros,
    gatewayActualCostMicros: 0,
    gcpCostMicros: 0,
    otherCostMicros: 0,
  }, MONTHLY_TARGET_MICROS, false).percentageUsed;
}

describe("cost safety alert thresholds", () => {
  it.each([
    [9_999_999, 10_000_000, 50],
    [14_999_999, 15_000_000, 75],
    [17_999_999, 18_000_000, 90],
  ])(
    "crossing %i to %i micro-dollars emits the expected $20-target threshold",
    (beforeMicros, afterMicros, expectedThreshold) => {
      expect(crossedThresholds(
        percentageAt(beforeMicros),
        percentageAt(afterMicros),
        DEFAULT_ALERT_THRESHOLDS,
      )).toEqual([expectedThreshold]);
    },
  );
});
