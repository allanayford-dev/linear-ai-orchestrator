import { describe, expect, it, vi } from "vitest";
import type { DashboardRepository } from "../repositories/dashboard-repository.js";
import { VercelCostReconciliationService } from "./vercel-cost-reconciliation-service.js";
import type { VercelReportClient } from "./vercel-report-client.js";

describe("VercelCostReconciliationService", () => {
  it("writes the current UTC month report idempotently", async () => {
    const reportClient = {
      getSpend: vi.fn().mockResolvedValue({ totalCostMicros: 57_618, requestCount: 11 }),
    } as unknown as VercelReportClient;
    const repository = {
      syncGatewayCost: vi.fn().mockResolvedValue(undefined),
      recordGatewaySyncFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as DashboardRepository;
    const service = new VercelCostReconciliationService(reportClient, repository);
    const result = await service.reconcile(new Date("2026-07-13T18:00:00Z"));
    expect(result).toMatchObject({
      month: "2026-07",
      startDate: "2026-07-01",
      endDate: "2026-07-13",
      gatewayActualCostMicros: 57_618,
    });
    expect(repository.syncGatewayCost).toHaveBeenCalledWith("2026-07", {
      gatewayActualCostMicros: 57_618,
      requestCount: 11,
      startDate: "2026-07-01",
      endDate: "2026-07-13",
    });
  });

  it("records a visible sync failure without replacing the last actual cost", async () => {
    const reportClient = {
      getSpend: vi.fn().mockRejectedValue(new Error("Custom Reporting is unavailable")),
    } as unknown as VercelReportClient;
    const repository = {
      syncGatewayCost: vi.fn(),
      recordGatewaySyncFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as DashboardRepository;
    const service = new VercelCostReconciliationService(reportClient, repository);

    await expect(service.reconcile(new Date("2026-07-13T18:00:00Z")))
      .rejects.toThrow("Custom Reporting is unavailable");
    expect(repository.recordGatewaySyncFailure).toHaveBeenCalledWith(
      "2026-07",
      "Custom Reporting is unavailable",
    );
    expect(repository.syncGatewayCost).not.toHaveBeenCalled();
  });
});
