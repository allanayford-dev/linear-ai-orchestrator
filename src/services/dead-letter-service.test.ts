import { describe, expect, it, vi } from "vitest";
import type { DeadLetterRepository } from "../repositories/dead-letter-repository.js";
import { DeadLetterService } from "./dead-letter-service.js";

function repository() {
  return { record: vi.fn().mockResolvedValue("recorded") };
}

describe("DeadLetterService", () => {
  it("normalizes Google dead-letter attributes and work context", async () => {
    const repo = repository();
    const service = new DeadLetterService(repo as DeadLetterRepository);
    const work = {
      deliveryId: "delivery-1",
      source: "linear",
      receivedAt: "2026-07-13T20:00:00.000Z",
      payload: { data: { identifier: "ALL-277" } },
    };
    await service.record({
      message: {
        messageId: "dlq-message-1",
        publishTime: "2026-07-13T20:05:00.000Z",
        data: Buffer.from(JSON.stringify(work)).toString("base64"),
        attributes: {
          CloudPubSubDeadLetterSourceSubscription:
            "projects/glm-api-server/subscriptions/orchestrator-worker",
          CloudPubSubDeadLetterSourceSubscriptionProject: "glm-api-server",
          CloudPubSubDeadLetterSourceDeliveryCount: "5",
          CloudPubSubDeadLetterSourceTopicPublishTime: "2026-07-13T20:00:01.000Z",
        },
      },
      subscription:
        "projects/glm-api-server/subscriptions/orchestrator-dead-letter-monitor",
    });

    expect(repo.record).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "dlq-message-1",
      deliveryId: "delivery-1",
      issueIdentifier: "ALL-277",
      sourceDeliveryCount: 5,
      malformed: false,
    }));
  });

  it("creates the same id for repeated deliveries", async () => {
    const repo = repository();
    const service = new DeadLetterService(repo as DeadLetterRepository);
    const body = { message: { messageId: "same", data: "e30=" }, subscription: "dead" };
    await service.record(body);
    await service.record(body);
    const first = repo.record.mock.calls[0][0];
    const second = repo.record.mock.calls[1][0];
    expect(first.id).toBe(second.id);
  });

  it("normalizes malformed payloads instead of rejecting them", async () => {
    const repo = repository();
    const service = new DeadLetterService(repo as DeadLetterRepository);
    await service.record({ unexpected: true });
    expect(repo.record).toHaveBeenCalledWith(expect.objectContaining({
      malformed: true,
      messageId: null,
      validationErrors: expect.arrayContaining(["message is missing"]),
    }));
  });
});
