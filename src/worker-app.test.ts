import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createWorkerApp } from "./worker-app.js";
import type { OrchestratorWorkerService } from "./services/orchestrator-worker-service.js";
import type { VercelCostReconciliationService } from "./services/vercel-cost-reconciliation-service.js";

describe("worker app", () => {
  it("reports health", async () => {
    const worker = { handle: vi.fn() } as unknown as OrchestratorWorkerService;
    await request(createWorkerApp(worker))
      .get("/health")
      .expect(200, { status: "ok", service: "orchestrator-worker" });
  });

  it("acknowledges a valid Pub/Sub delivery", async () => {
    const worker = {
      handle: vi.fn().mockResolvedValue({ outcome: "ignored" }),
    } as unknown as OrchestratorWorkerService;
    const payload = {
      deliveryId: "delivery-1",
      source: "linear",
      receivedAt: new Date().toISOString(),
      payload: { action: "create", type: "Issue", data: { id: "issue-1" }, webhookTimestamp: Date.now() },
    };
    const response = await request(createWorkerApp(worker)).post("/pubsub/push").send({
      message: { messageId: "message-1", data: Buffer.from(JSON.stringify(payload)).toString("base64") },
    });

    expect(response.status).toBe(204);
    expect(response.headers["x-orchestrator-outcome"]).toBe("ignored");
    expect(worker.handle).toHaveBeenCalledWith(payload);
  });

  it("runs a Vercel reconciliation request", async () => {
    const worker = { handle: vi.fn() } as unknown as OrchestratorWorkerService;
    const reconciliation = {
      reconcile: vi.fn().mockResolvedValue({
        month: "2026-07",
        gatewayActualCostMicros: 57_618,
        requestCount: 11,
      }),
    } as unknown as VercelCostReconciliationService;
    const response = await request(createWorkerApp(worker, reconciliation))
      .post("/internal/reconcile/vercel")
      .expect(200);
    expect(response.body.gatewayActualCostMicros).toBe(57_618);
    expect(reconciliation.reconcile).toHaveBeenCalledTimes(1);
  });
});
