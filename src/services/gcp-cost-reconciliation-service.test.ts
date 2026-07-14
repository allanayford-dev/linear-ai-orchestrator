import { describe, expect, it, vi } from "vitest";
import type { GcpCostRepository } from "../repositories/gcp-cost-repository.js";
import type { GcpBillingClient } from "./gcp-billing-client.js";
import { GcpCostReconciliationService } from "./gcp-cost-reconciliation-service.js";

const table = "project.dataset.table";
const projectId = "glm-api-server";

describe("GcpCostReconciliationService", () => {
  it("persists a successful aggregate as a set value", async () => {
    const result = {
      costMicros: 2500,
      currency: "USD",
      rowCount: 3,
      table,
      projectId,
      queryStart: "2026-07-01T00:00:00.000Z",
      queryEnd: "2026-08-01T00:00:00.000Z",
    };
    const client = { getMonth: vi.fn().mockResolvedValue(result) };
    const repository = { complete: vi.fn(), fail: vi.fn() };
    const service = new GcpCostReconciliationService(
      client as GcpBillingClient,
      repository as GcpCostRepository,
      table,
      projectId,
    );

    await expect(service.reconcile("2026-07")).resolves.toMatchObject(result);
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({
      month: "2026-07",
      costMicros: 2500,
      attemptId: expect.any(String),
    }));
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("audits query failures without replacing the prior cost", async () => {
    const failure = new Error("table is not ready");
    const client = { getMonth: vi.fn().mockRejectedValue(failure) };
    const repository = { complete: vi.fn(), fail: vi.fn() };
    const service = new GcpCostReconciliationService(
      client as GcpBillingClient,
      repository as GcpCostRepository,
      table,
      projectId,
    );

    await expect(service.reconcile("2026-07")).rejects.toThrow("table is not ready");
    expect(repository.fail).toHaveBeenCalledWith(
      expect.any(String),
      "2026-07",
      table,
      projectId,
      failure,
    );
  });
});
