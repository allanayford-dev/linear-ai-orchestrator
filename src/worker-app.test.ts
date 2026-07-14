import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createWorkerApp } from "./worker-app.js";
import type { OrchestratorWorkerService } from "./services/orchestrator-worker-service.js";
import type { DeadLetterService } from "./services/dead-letter-service.js";

function deadLetters(outcome: "recorded" | "duplicate" = "recorded") {
  return { record: vi.fn().mockResolvedValue(outcome) } as unknown as DeadLetterService;
}

describe("worker app", () => {
  it("reports health", async () => {
    const worker = { handle: vi.fn() } as unknown as OrchestratorWorkerService;
    await request(createWorkerApp(worker, deadLetters()))
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
    const response = await request(createWorkerApp(worker, deadLetters())).post("/pubsub/push").send({
      message: { messageId: "message-1", data: Buffer.from(JSON.stringify(payload)).toString("base64") },
    });

    expect(response.status).toBe(204);
    expect(response.headers["x-orchestrator-outcome"]).toBe("ignored");
    expect(worker.handle).toHaveBeenCalledWith(payload);
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
    const response = await request(createWorkerApp(worker, recorder))
      .post("/pubsub/dead-letter")
      .send(body);

    expect(response.status).toBe(204);
    expect(response.headers["x-orchestrator-outcome"]).toBe("recorded");
    expect(recorder.record).toHaveBeenCalledWith(body);
  });

  it("passes malformed dead-letter bodies to the recorder and acknowledges them", async () => {
    const worker = { handle: vi.fn() } as unknown as OrchestratorWorkerService;
    const recorder = deadLetters();
    const response = await request(createWorkerApp(worker, recorder))
      .post("/pubsub/dead-letter")
      .send({ unexpected: true });

    expect(response.status).toBe(204);
    expect(recorder.record).toHaveBeenCalledWith({ unexpected: true });
  });

});
