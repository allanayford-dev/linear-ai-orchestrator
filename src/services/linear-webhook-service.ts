import type { WebhookRepository } from "../repositories/webhook-repository.js";
import type { LinearWebhookPayload } from "../types/linear.js";
import type { EventPublisher } from "./event-publisher.js";

export interface WebhookResult {
  duplicate: boolean;
  messageId?: string;
}

export class LinearWebhookService {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly publisher: EventPublisher,
  ) {}

  async handle(
    deliveryId: string,
    payload: LinearWebhookPayload,
  ): Promise<WebhookResult> {
    if (await this.repository.isPublished(deliveryId)) {
      return { duplicate: true };
    }

    await this.repository.recordReceived(deliveryId, payload);
    const messageId = await this.publisher.publish({
      deliveryId,
      source: "linear",
      receivedAt: new Date().toISOString(),
      payload,
    });
    await this.repository.markPublished(deliveryId, messageId);

    return { duplicate: false, messageId };
  }
}
