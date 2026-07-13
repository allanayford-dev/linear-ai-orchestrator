import type { LinearWebhookPayload } from "../types/linear.js";

export interface WebhookRepository {
  isPublished(deliveryId: string): Promise<boolean>;
  recordReceived(
    deliveryId: string,
    payload: LinearWebhookPayload,
  ): Promise<void>;
  markPublished(deliveryId: string, messageId: string): Promise<void>;
}
