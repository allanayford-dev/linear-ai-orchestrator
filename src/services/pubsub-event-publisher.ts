import { PubSub } from "@google-cloud/pubsub";
import type { EventPublisher, OrchestratorEvent } from "./event-publisher.js";

export class PubSubEventPublisher implements EventPublisher {
  constructor(
    private readonly pubsub: PubSub,
    private readonly topicName: string,
  ) {}

  async publish(event: OrchestratorEvent): Promise<string> {
    return this.pubsub.topic(this.topicName).publishMessage({
      data: Buffer.from(JSON.stringify(event)),
      attributes: {
        source: event.source,
        deliveryId: event.deliveryId,
        eventType: event.payload.type,
        action: event.payload.action,
      },
    });
  }
}
