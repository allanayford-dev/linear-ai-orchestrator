import type {
  ExecutionResult,
  LinearIssue,
  ModelResult,
  RouteDecision,
} from "../types/worker.js";

export interface ModelClient {
  route(issue: LinearIssue, model: string): Promise<ModelResult<RouteDecision>>;
  execute(
    issue: LinearIssue,
    route: RouteDecision,
    model: string,
  ): Promise<ModelResult<ExecutionResult>>;
}

export function parseJson<T>(text: string): T {
  const unwrapped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unwrapped) as T;
  } catch {
    const start = unwrapped.indexOf("{");
    const end = unwrapped.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Model did not return JSON");
    return JSON.parse(unwrapped.slice(start, end + 1)) as T;
  }
}

export function ensureRoute(value: RouteDecision): RouteDecision {
  if (
    !["simple", "complex"].includes(value.complexity) ||
    !["execute", "needs_human"].includes(value.outcome) ||
    typeof value.reason !== "string"
  ) {
    throw new Error("Invalid router response");
  }
  return value;
}

export function ensureExecution(value: ExecutionResult): ExecutionResult {
  if (
    !["ready_for_review", "needs_human"].includes(value.outcome) ||
    typeof value.summary !== "string" ||
    typeof value.result !== "string" ||
    !Array.isArray(value.verification)
  ) {
    throw new Error("Invalid executor response");
  }
  return value;
}

export const routeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["complexity", "outcome", "reason"],
  properties: {
    complexity: { type: "string", enum: ["simple", "complex"] },
    outcome: { type: "string", enum: ["execute", "needs_human"] },
    reason: { type: "string" },
    humanAction: { type: "string" },
  },
};

export const executionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "result", "verification"],
  properties: {
    outcome: {
      type: "string",
      enum: ["ready_for_review", "needs_human"],
    },
    summary: { type: "string" },
    result: { type: "string" },
    verification: { type: "array", items: { type: "string" } },
    humanAction: { type: "string" },
  },
};

export const routerSystem =
  "You route Linear work. Return JSON only. Choose needs_human when credentials, approval, missing requirements, physical action, or an unavailable repository/runtime is required. Never claim work was performed.";

export function routerPrompt(issue: LinearIssue): string {
  return `Classify this issue. JSON schema: {"complexity":"simple|complex","outcome":"execute|needs_human","reason":"...","humanAction":"optional"}.\nIssue: ${issue.identifier}\nTitle: ${issue.title}\nDescription:\n${issue.description ?? "(none)"}`;
}

export const executorSystem =
  "Produce a useful, reviewable result for a Linear issue. Return JSON only. Do not claim files were changed, tests ran, deployments happened, or external systems were updated unless the prompt includes evidence. If real execution needs tools you do not have, return needs_human with an exact next action.";

export function executorPrompt(issue: LinearIssue, route: RouteDecision): string {
  return `Resolve what can safely be resolved from the issue text. JSON schema: {"outcome":"ready_for_review|needs_human","summary":"...","result":"...","verification":["..."],"humanAction":"optional"}.\nRouter reason: ${route.reason}\nIssue: ${issue.identifier}\nTitle: ${issue.title}\nDescription:\n${issue.description ?? "(none)"}`;
}
