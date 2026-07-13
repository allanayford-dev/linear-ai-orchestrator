export interface AppConfig {
  port: number;
  nodeEnv: string;
  gcpProjectId?: string;
  pubsubTopic: string;
  firestoreDatabaseId: string;
  linearWebhookSecret: string;
  linearWebhookToleranceMs: number;
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const linearWebhookSecret = process.env.LINEAR_WEBHOOK_SECRET?.trim();
  if (!linearWebhookSecret) {
    throw new Error("LINEAR_WEBHOOK_SECRET is required");
  }

  const gcpProjectId = process.env.GCP_PROJECT_ID?.trim();

  return {
    port: readPositiveInteger("PORT", 8080),
    nodeEnv: process.env.NODE_ENV ?? "development",
    ...(gcpProjectId ? { gcpProjectId } : {}),
    pubsubTopic: process.env.PUBSUB_TOPIC?.trim() || "orchestrator-tasks",
    firestoreDatabaseId:
      process.env.FIRESTORE_DATABASE_ID?.trim() || "(default)",
    linearWebhookSecret,
    linearWebhookToleranceMs: readPositiveInteger(
      "LINEAR_WEBHOOK_TOLERANCE_MS",
      60_000,
    ),
  };
}
