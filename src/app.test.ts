import { createHmac } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { AppConfig } from "./config/env.js";
import type { WebhookRepository } from "./repositories/webhook-repository.js";
import type {
  EventPublisher,
  OrchestratorEvent,
} from "./services/event-publisher.js";
import { LinearWebhookService } from "./services/linear-webhook-service.js";
import type { LinearWebhookPayload } from "./types/linear.js";

const secret = "test-webhook-secret";
const now = 1_750_000_000_000;
const config: AppConfig = {
  port: 8080,
  nodeEnv: "test",
  gcpProjectId: "test-project",
  pubsubTopic: "orchestrator-tasks",
  firestoreDatabaseId: "(default)",
  linearWebhookSecret: secret,
  linearWebhookToleranceMs: 60_000,
};

class MemoryRepository implements WebhookRepository {
  readonly received = new Map<string, LinearWebhookPayload>();
  readonly published = new Map<string, string>();

  async isPublished(deliveryId: string): Promise<boolean> {
    return this.published.has(deliveryId);
  }

  async recordReceived(
    deliveryId: string,
    payload: LinearWebhookPayload,
  ): Promise<void> {
    this.received.set(deliveryId, payload);
  }

  async markPublished(deliveryId: string, messageId: string): Promise<void> {
    this.published.set(deliveryId, messageId);
  }
}

class MemoryPublisher implements EventPublisher {
  readonly events: OrchestratorEvent[] = [];

  async publish(event: OrchestratorEvent): Promise<string> {
    this.events.push(event);
    return `message-${this.events.length}`;
  }
}

function createTestApp() {
  const repository = new MemoryRepository();
  const publisher = new MemoryPublisher();
  const webhookService = new LinearWebhookService(repository, publisher);
  return {
    app: createApp({ config, webhookService, now: () => now }),
    repository,
    publisher,
  };
}

function signedHeaders(rawBody: string) {
  return {
    "content-type": "application/json",
    "linear-delivery": "delivery-123",
    "linear-signature": createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex"),
  };
}

function issuePayload(timestamp = now) {
  return {
    action: "update",
    type: "Issue",
    webhookTimestamp: timestamp,
    organizationId: "organization-1",
    data: {
      id: "issue-uuid-1",
      identifier: "ALL-234",
      title: "Pilot issue",
      projectId: "project-1",
      state: { id: "state-1", name: "Todo" },
    },
  };
}

describe("linear webhook service", () => {
  it("reports service health", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/healthz");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", service: "linear-webhook" });
  });

  it("rejects an invalid signature", async () => {
    const { app } = createTestApp();
    const response = await request(app)
      .post("/webhooks/linear")
      .set("content-type", "application/json")
      .set("linear-delivery", "delivery-123")
      .set("linear-signature", "0".repeat(64))
      .send(JSON.stringify(issuePayload()));
    expect(response.status).toBe(401);
  });

  it("rejects a stale webhook", async () => {
    const { app } = createTestApp();
    const rawBody = JSON.stringify(issuePayload(now - 60_001));
    const response = await request(app)
      .post("/webhooks/linear")
      .set(signedHeaders(rawBody))
      .send(rawBody);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("stale webhook timestamp");
  });

  it("persists and publishes a verified event", async () => {
    const { app, repository, publisher } = createTestApp();
    const rawBody = JSON.stringify(issuePayload());
    const response = await request(app)
      .post("/webhooks/linear")
      .set(signedHeaders(rawBody))
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      accepted: true,
      duplicate: false,
      messageId: "message-1",
    });
    expect(repository.received.get("delivery-123")?.data.identifier).toBe(
      "ALL-234",
    );
    expect(publisher.events).toHaveLength(1);
  });

  it("acknowledges a published duplicate without publishing twice", async () => {
    const { app, publisher } = createTestApp();
    const rawBody = JSON.stringify(issuePayload());

    await request(app)
      .post("/webhooks/linear")
      .set(signedHeaders(rawBody))
      .send(rawBody);
    const response = await request(app)
      .post("/webhooks/linear")
      .set(signedHeaders(rawBody))
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: true, duplicate: true });
    expect(publisher.events).toHaveLength(1);
  });
});
