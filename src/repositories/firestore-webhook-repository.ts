import { FieldValue, Firestore } from "@google-cloud/firestore";
import type { LinearWebhookPayload } from "../types/linear.js";
import type { WebhookRepository } from "./webhook-repository.js";

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nestedString(
  value: unknown,
  property: string,
): string | null {
  if (!value || typeof value !== "object") return null;
  return optionalString((value as Record<string, unknown>)[property]);
}

export class FirestoreWebhookRepository implements WebhookRepository {
  constructor(private readonly firestore: Firestore) {}

  async isPublished(deliveryId: string): Promise<boolean> {
    const snapshot = await this.firestore
      .collection("webhook_events")
      .doc(deliveryId)
      .get();
    return snapshot.exists && snapshot.get("status") === "published";
  }

  async recordReceived(
    deliveryId: string,
    payload: LinearWebhookPayload,
  ): Promise<void> {
    const eventRef = this.firestore.collection("webhook_events").doc(deliveryId);
    const issueId = payload.type === "Issue" ? optionalString(payload.data.id) : null;
    const taskRef = issueId
      ? this.firestore.collection("tasks").doc(issueId)
      : null;
    const usageRef = issueId
      ? this.firestore.collection("task_usage").doc(issueId)
      : null;

    await this.firestore.runTransaction(async (transaction) => {
      const usageSnapshot = usageRef ? await transaction.get(usageRef) : null;

      transaction.set(
        eventRef,
        {
          deliveryId,
          status: "received",
          source: "linear",
          eventType: payload.type,
          action: payload.action,
          organizationId: payload.organizationId ?? null,
          webhookId: payload.webhookId ?? null,
          webhookTimestamp: payload.webhookTimestamp,
          payload,
          receivedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      if (!taskRef || !usageRef) return;

      const issueIdentifier = optionalString(payload.data.identifier);
      const projectId =
        optionalString(payload.data.projectId) ??
        nestedString(payload.data.project, "id");
      const stateId =
        optionalString(payload.data.stateId) ?? nestedString(payload.data.state, "id");
      const stateName = nestedString(payload.data.state, "name");

      transaction.set(
        taskRef,
        {
          linearIssueId: issueId,
          issueIdentifier,
          title: optionalString(payload.data.title),
          projectId,
          stateId,
          stateName,
          url: payload.url ?? optionalString(payload.data.url),
          lastAction: payload.action,
          lastDeliveryId: deliveryId,
          linearUpdatedAt: optionalString(payload.data.updatedAt),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      if (!usageSnapshot?.exists) {
        transaction.create(usageRef, {
          taskId: issueId,
          issueIdentifier,
          projectId,
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostMicros: 0,
          billedCostMicros: 0,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
  }

  async markPublished(deliveryId: string, messageId: string): Promise<void> {
    await this.firestore.collection("webhook_events").doc(deliveryId).set(
      {
        status: "published",
        pubsubMessageId: messageId,
        publishedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}
