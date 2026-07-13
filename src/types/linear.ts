export interface LinearWebhookPayload {
  action: string;
  type: string;
  data: Record<string, unknown>;
  webhookTimestamp: number;
  organizationId?: string;
  webhookId?: string;
  createdAt?: string;
  url?: string;
  updatedFrom?: Record<string, unknown>;
}

export function parseLinearWebhookPayload(value: unknown): LinearWebhookPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Webhook body must be a JSON object");
  }

  const body = value as Record<string, unknown>;
  if (typeof body.action !== "string" || !body.action) {
    throw new Error("Webhook action is required");
  }
  if (typeof body.type !== "string" || !body.type) {
    throw new Error("Webhook type is required");
  }
  if (!body.data || typeof body.data !== "object") {
    throw new Error("Webhook data is required");
  }
  if (
    typeof body.webhookTimestamp !== "number" ||
    !Number.isFinite(body.webhookTimestamp)
  ) {
    throw new Error("Webhook timestamp is required");
  }

  return body as unknown as LinearWebhookPayload;
}
