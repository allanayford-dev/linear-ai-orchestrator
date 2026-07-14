import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createWorkerApp } from "./worker-app.js";
import type { OrchestratorWorkerService } from "./services/orchestrator-worker-service.js";
import type { DeadLetterService } from "./services/dead-letter-service.js";
import type { GcpCostReconciliationService } from "./services/gcp-cost-reconciliation-service.js";

function deadLetters(outcome: "recorded" | "duplicate" = "recorded") {
  return { record: vi.fn().mockResolvedValue(outcome) } as unknown as DeadLetterService;
}

function gcpCosts() {
  return {
    reconcile: vi.fn().mockResolvedValue({
      attemptId: "attempt-1",
      costMicros: 1234,
      currency: "USD",
      rowCount: 4,
    }),
  } as unknown as GcpCostReconciliationService;
}

describe("worker app", () => {
  it("reports health", async () => {
    const worker = { handle: vi.fn() } as unknown as OrchestratorWorkerService;
    await request(createWorkerApp(worker, deadLetters(), gcpCosts()))
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
    const response = await request(createWorkerApp(worker, deadLetters(), gcpCosts())).post("/pubsub/push").send({
      message: { messageId: "message-1", data: Buffer.from(JSON.stringify(payload)).toString("base64") },
    });

    expect(response.status).toBe(204);
    expect(response.headers["x-orchestrator-outcome"]).toBe("ignored");
    expect(worker.handle).toHaveBeenCalledWith({
      ...payload,
      deliveryAttempt: 1,
      pubsubMessageId: "message-1",
      subscription: null,
    });
  });

  it("passes Pub/Sub delivery attempt metadata to the worker", async () => {
    const worker = {
      handle: vi.fn().mockResolvedValue({ outcome: "ignored" }),
    } as unknown as OrchestratorWorkerService;
    const payload = {
      deliveryId: "delivery-5",
      source: "linear",
      receivedAt: new Date().toISOString(),
      payload: { action: "create", type: "Issue", data: { id: "issue-1" } },
    };
    await request(createWorkerApp(worker, deadLetters(), gcpCosts())).post("/pubsub/push").send({
      message: { messageId: "message-5", data: Buffer.from(JSON.stringify(payload)).toString("base64") },
      subscription: "projects/project/subscriptions/orchestrator-worker",
      deliveryAttempt: 5,
    }).expect(204);

    expect(worker.handle).toHaveBeenCalledWith(expect.objectContaining({
      deliveryAttempt: 5,
      pubsubMessageId: "message-5",
      subscription: "projects/project/subscriptions/orchestrator-worker",
    }));
  });

  it("returns a retryable response when the application delivery limit is reached", async () => {
    const limitError = new Error("delivery limit reached");
    limitError.name = "DeliveryLimitExceededError";
    const worker = {
      handle: vi.fn().mockRejectedValue(limitError),
    } as unknown as OrchestratorWorkerService;
    const payload = {
      deliveryId: "delivery-limit",
      source: "linear",
      receivedAt: new Date().toISOString(),
      payload: { action: "create", type: "Issue", data: { id: "issue-1" } },
    };

    await request(createWorkerApp(worker, deadLetters(), gcpCosts())).post("/pubsub/push").send({
      message: { messageId: "message-limit", data: Buffer.from(JSON.stringify(payload)).toString("base64") },
      deliveryAttempt: 5,
    }).expect(500, { error: "delivery failed" });
  });

  it("records and acknowledges a dead-letter delivery", async () => {
    const worker = { handle: vi.fn() } as unknown as OrchestratorWorkerService;
    const recorder = deadLetters();
    const body = {
      message: {
        messageId: "dead-letter-1",
        data: Buffer.from("failed work").toString("base64"),
      },
      subscription: "projects/project/subscriptions/orchestrator-dead-letter-monitor",
    };
    const response = await request(createWorkerApp(worker, recorder, gcpCosts()))
      .post("/pubsub/dead-letter")
      .send(body);

    expect(response.status).toBe(204);
    expect(response.headers["x-orchestrator-outcome"]).toBe("recorded");
    expect(recorder.record).toHaveBeenCalledWith(body);
  });

  it("passes malformed dead-letter bodies to the recorder and acknowledges them", async () => {
    const worker = { handle: vi.fn() } as unknown as OrchestratorWorkerService;
    const recorder = deadLetters();
    const response = await request(createWorkerApp(worker, recorder, gcpCosts()))
      .post("/pubsub/dead-letter")
      .send({ unexpected: true });

    expect(response.status).toBe(204);
    expect(recorder.record).toHaveBeenCalledWith({ unexpected: true });
  });

  it("runs an internal Google Cloud cost reconciliation for a requested month", async () => {
    const worker = { handle: vi.fn() } as unknown as OrchestratorWorkerService;
    const costs = gcpCosts();
    const response = await request(createWorkerApp(worker, deadLetters(), costs))
      .post("/internal/reconcile/gcp?month=2026-07")
      .expect(200);

    expect(response.body).toMatchObject({ attemptId: "attempt-1", costMicros: 1234 });
    expect(costs.reconcile).toHaveBeenCalledWith("2026-07");
  });

});
