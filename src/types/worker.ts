import type { LinearWebhookPayload } from "./linear.js";

export interface PubSubPushEnvelope {
  message: {
    data: string;
    messageId: string;
    attributes?: Record<string, string>;
    publishTime?: string;
  };
  subscription?: string;
}

export interface WorkEvent {
  deliveryId: string;
  source: string;
  receivedAt: string;
  payload: LinearWebhookPayload;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: { id: string; name: string };
  team: {
    id: string;
    states: Array<{ id: string; name: string; type: string }>;
  };
  project: { id: string; name: string } | null;
  labels: Array<{ id: string; name: string }>;
}

export type ModelRole = "router" | "executor";
export type ModelProvider = "google-gemini" | "vercel-ai-gateway";
export type PricingTier = "free" | "paid";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostMicros: number;
  pricing: { inputPerToken: number; outputPerToken: number } | null;
}

export interface ModelResult<T> {
  value: T;
  rawText: string;
  usage: ModelUsage;
  providerRequestId: string | null;
}

export interface RouteDecision {
  complexity: "simple" | "complex";
  outcome: "execute" | "needs_human";
  reason: string;
  humanAction?: string;
}

export interface ExecutionResult {
  outcome: "ready_for_review" | "needs_human";
  summary: string;
  result: string;
  verification: string[];
  humanAction?: string;
}

export function parsePubSubEnvelope(value: unknown): PubSubPushEnvelope {
  if (!value || typeof value !== "object") throw new Error("Body is required");
  const message = (value as Record<string, unknown>).message;
  if (!message || typeof message !== "object") throw new Error("message is required");
  const record = message as Record<string, unknown>;
  if (typeof record.data !== "string" || typeof record.messageId !== "string") {
    throw new Error("message.data and message.messageId are required");
  }
  return value as PubSubPushEnvelope;
}

export function decodeWorkEvent(envelope: PubSubPushEnvelope): WorkEvent {
  const decoded = Buffer.from(envelope.message.data, "base64").toString("utf8");
  const parsed = JSON.parse(decoded) as Partial<WorkEvent>;
  if (
    !parsed.deliveryId ||
    !parsed.source ||
    !parsed.receivedAt ||
    !parsed.payload
  ) {
    throw new Error("Invalid work event");
  }
  return parsed as WorkEvent;
}
