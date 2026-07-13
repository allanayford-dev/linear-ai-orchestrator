import type { LinearWebhookPayload } from "../types/linear.js";

export interface OrchestratorEvent {
  deliveryId: string;
  source: "linear";
  receivedAt: string;
  payload: LinearWebhookPayload;
}

export interface EventPublisher {
  publish(event: OrchestratorEvent): Promise<string>;
}
