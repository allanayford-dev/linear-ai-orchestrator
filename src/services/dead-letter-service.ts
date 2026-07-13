import { createHash } from "node:crypto";
import type {
  DeadLetterRecord,
  DeadLetterRepository,
  DeadLetterWriteResult,
} from "../repositories/dead-letter-repository.js";

const SOURCE_SUBSCRIPTION = "CloudPubSubDeadLetterSourceSubscription";
const SOURCE_PROJECT = "CloudPubSubDeadLetterSourceSubscriptionProject";
const SOURCE_DELIVERY_COUNT = "CloudPubSubDeadLetterSourceDeliveryCount";
const SOURCE_PUBLISH_TIME = "CloudPubSubDeadLetterSourceTopicPublishTime";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): Record<string, string> {
  const record = object(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"),
  );
}

function safeDecodedData(data: string | null, errors: string[]): unknown {
  if (data === null) return null;
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    errors.push("message.data is not valid base64");
    return null;
  }
  try {
    const decoded = Buffer.from(data, "base64").toString("utf8");
    if (decoded.length > 100_000) {
      errors.push("decoded message exceeds the 100 KB diagnostic limit");
      return decoded.slice(0, 100_000);
    }
    try {
      return JSON.parse(decoded) as unknown;
    } catch {
      return decoded;
    }
  } catch {
    errors.push("message.data is not valid base64");
    return null;
  }
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizedRecord(value: unknown): DeadLetterRecord {
  const body = object(value);
  const message = object(body?.message);
  const errors: string[] = [];
  if (!body) errors.push("body is not an object");
  if (!message) errors.push("message is missing");
  const messageId = stringField(message, "messageId") ?? stringField(message, "message_id");
  if (!messageId) errors.push("message.messageId is missing");
  const rawDataBase64 = stringField(message, "data");
  if (!rawDataBase64) errors.push("message.data is missing");
  if (rawDataBase64 && rawDataBase64.length > 500_000) {
    errors.push("message.data exceeds the 500 KB diagnostic limit");
  }
  const dataBase64 = rawDataBase64?.slice(0, 500_000) ?? null;
  const attributes = strings(message?.attributes);
  const decodedData = safeDecodedData(dataBase64, errors);
  const decoded = object(decodedData);
  const payload = object(decoded?.payload);
  const issue = object(payload?.data);
  const deliveryCount = Number(attributes[SOURCE_DELIVERY_COUNT]);
  const identity = messageId ?? createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
  const subscription = stringField(body, "subscription") ?? "unknown-subscription";

  return {
    id: createHash("sha256").update(`${subscription}:${identity}`).digest("hex"),
    messageId,
    deadLetterSubscription: stringField(body, "subscription"),
    sourceSubscription: attributes[SOURCE_SUBSCRIPTION] ?? null,
    sourceSubscriptionProject: attributes[SOURCE_PROJECT] ?? null,
    sourceDeliveryCount: Number.isSafeInteger(deliveryCount) && deliveryCount >= 0
      ? deliveryCount
      : null,
    sourceTopicPublishTime: attributes[SOURCE_PUBLISH_TIME] ?? null,
    publishTime: stringField(message, "publishTime") ?? stringField(message, "publish_time"),
    deliveryId: stringField(decoded, "deliveryId"),
    issueIdentifier: stringField(issue, "identifier"),
    attributes,
    dataBase64,
    decodedData,
    malformed: errors.length > 0,
    validationErrors: errors,
  };
}

export class DeadLetterService {
  constructor(private readonly repository: DeadLetterRepository) {}

  record(value: unknown): Promise<DeadLetterWriteResult> {
    return this.repository.record(normalizedRecord(value));
  }
}
