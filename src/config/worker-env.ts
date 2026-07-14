export interface WorkerConfig {
  port: number;
  projectId?: string;
  databaseId: string;
  linearApiKey: string;
  aiGatewayApiKey: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiAllowedProjects: string[];
  geminiSensitiveLabels: string[];
  routerModel: string;
  executorModel: string;
  states: {
    todo: string;
    inProgress: string;
    needsAction: string;
    review: string;
  };
  leaseSeconds: number;
  maxDeliveryAttempts: number;
  maxTaskCostMicros: number;
  maxTaskTokens: number;
  maxProjectMonthlyCostMicros: number;
  maxSystemMonthlyCostMicros: number;
  paidAiCircuitBreakerMicros: number;
  gcpBilling: {
    table: string;
    location: string;
    projectId: string;
    maximumBytesBilled: number;
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function list(name: string, fallback: string[] = []): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

export function loadWorkerConfig(): WorkerConfig {
  const projectId = process.env.GCP_PROJECT_ID?.trim();
  const maxDeliveryAttempts = integer("MAX_DELIVERY_ATTEMPTS", 5);
  if (maxDeliveryAttempts < 1) {
    throw new Error("MAX_DELIVERY_ATTEMPTS must be greater than zero");
  }
  return {
    port: integer("PORT", 8080),
    ...(projectId ? { projectId } : {}),
    databaseId: process.env.FIRESTORE_DATABASE_ID?.trim() || "(default)",
    linearApiKey: required("LINEAR_API_KEY"),
    aiGatewayApiKey: required("AI_GATEWAY_API_KEY"),
    geminiApiKey: required("GEMINI_API_KEY"),
    geminiModel:
      process.env.GEMINI_MODEL?.trim() || "gemini-3.1-flash-lite",
    geminiAllowedProjects: list("GEMINI_ALLOWED_PROJECTS"),
    geminiSensitiveLabels: list("GEMINI_SENSITIVE_LABELS", ["ai-sensitive"]),
    routerModel: process.env.ROUTER_MODEL?.trim() || "zai/glm-4.7-flashx",
    executorModel: process.env.EXECUTOR_MODEL?.trim() || "zai/glm-5.2",
    states: {
      todo: process.env.LINEAR_TODO_STATE?.trim() || "Todo",
      inProgress: process.env.LINEAR_IN_PROGRESS_STATE?.trim() || "In Progress",
      needsAction:
        process.env.LINEAR_NEEDS_ACTION_STATE?.trim() || "Needs My Action",
      review: process.env.LINEAR_REVIEW_STATE?.trim() || "In Review",
    },
    leaseSeconds: integer("TASK_LEASE_SECONDS", 900),
    maxDeliveryAttempts,
    maxTaskCostMicros: integer("MAX_TASK_COST_MICROS", 250_000),
    maxTaskTokens: integer("MAX_TASK_TOKENS", 50_000),
    maxProjectMonthlyCostMicros: integer(
      "MAX_PROJECT_MONTHLY_COST_MICROS",
      5_000_000,
    ),
    maxSystemMonthlyCostMicros: integer(
      "MAX_SYSTEM_MONTHLY_COST_MICROS",
      20_000_000,
    ),
    paidAiCircuitBreakerMicros: integer(
      "PAID_AI_CIRCUIT_BREAKER_MICROS",
      18_000_000,
    ),
    gcpBilling: {
      table: process.env.GCP_BILLING_TABLE?.trim() || "",
      location: process.env.GCP_BILLING_LOCATION?.trim() || "EU",
      projectId: process.env.GCP_BILLING_PROJECT_FILTER?.trim() || projectId || "",
      maximumBytesBilled: integer("GCP_BILLING_MAX_BYTES_BILLED", 100_000_000),
    },
  };
}
