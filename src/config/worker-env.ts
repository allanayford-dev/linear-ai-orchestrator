export interface WorkerConfig {
  port: number;
  projectId?: string;
  databaseId: string;
  linearApiKey: string;
  aiGatewayApiKey: string;
  routerModel: string;
  executorModel: string;
  states: {
    todo: string;
    inProgress: string;
    needsAction: string;
    review: string;
  };
  leaseSeconds: number;
  maxTaskCostMicros: number;
  maxProjectMonthlyCostMicros: number;
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

export function loadWorkerConfig(): WorkerConfig {
  const projectId = process.env.GCP_PROJECT_ID?.trim();
  return {
    port: integer("PORT", 8080),
    ...(projectId ? { projectId } : {}),
    databaseId: process.env.FIRESTORE_DATABASE_ID?.trim() || "(default)",
    linearApiKey: required("LINEAR_API_KEY"),
    aiGatewayApiKey: required("AI_GATEWAY_API_KEY"),
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
    maxTaskCostMicros: integer("MAX_TASK_COST_MICROS", 250_000),
    maxProjectMonthlyCostMicros: integer(
      "MAX_PROJECT_MONTHLY_COST_MICROS",
      5_000_000,
    ),
  };
}
