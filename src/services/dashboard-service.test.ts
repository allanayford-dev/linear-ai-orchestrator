import { describe, expect, it, vi } from "vitest";
import type { DashboardRepository } from "../repositories/dashboard-repository.js";
import { DashboardService } from "./dashboard-service.js";

function repository(): DashboardRepository {
  return {
    getDashboard: vi.fn(),
    updateBudget: vi.fn(),
    updateExternalCosts: vi.fn(),
    syncGatewayCost: vi.fn(),
    recordGatewaySyncFailure: vi.fn(),
  };
}

describe("DashboardService", () => {
  it("validates and writes budget controls", async () => {
    const repo = repository();
    const service = new DashboardService(repo);
    await service.updateBudget({
      budgetMicros: 20_000_000,
      paidAiCircuitBreakerMicros: 18_000_000,
      thresholds: [100, 50, 90, 50],
      paused: true,
    }, "owner@example.com");
    expect(repo.updateBudget).toHaveBeenCalledWith({
      budgetMicros: 20_000_000,
      paidAiCircuitBreakerMicros: 18_000_000,
      thresholds: [50, 90, 100],
      paused: true,
    }, "owner@example.com");
  });

  it("rejects invalid months and negative costs", async () => {
    const service = new DashboardService(repository());
    expect(() => service.getDashboard("2026-13")).toThrow("YYYY-MM");
    await expect(service.updateExternalCosts("2026-07", {
      gatewayActualCostMicros: -1,
      gcpCostMicros: 0,
      otherCostMicros: 0,
    }, "owner@example.com")).rejects.toThrow("non-negative");
  });
});
