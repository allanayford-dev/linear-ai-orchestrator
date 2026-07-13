import { describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../config/worker-env.js";
import type { WorkerRepository } from "../repositories/worker-repository.js";
import type {
  ExecutionResult,
  LinearIssue,
  ModelResult,
  RouteDecision,
  WorkEvent,
} from "../types/worker.js";
import type { AiGatewayClient } from "./ai-gateway-client.js";
import type { LinearClient } from "./linear-client.js";
import { OrchestratorWorkerService } from "./orchestrator-worker-service.js";

const config: WorkerConfig = {
  port: 8080,
  databaseId: "(default)",
  linearApiKey: "linear-key",
  aiGatewayApiKey: "gateway-key",
  routerModel: "zai/glm-4.7-flashx",
  executorModel: "zai/glm-5.2",
  states: { todo: "Todo", inProgress: "In Progress", needsAction: "Needs My Action", review: "In Review" },
  leaseSeconds: 900,
  maxTaskCostMicros: 250_000,
  maxProjectMonthlyCostMicros: 5_000_000,
};

function issue(state = "Todo"): LinearIssue {
  return {
    id: "issue-1",
    identifier: "ALL-1",
    title: "Prepare a rollout summary",
    description: "Write a concise summary from the supplied requirements.",
    url: "https://linear.app/issue/ALL-1",
    state: { id: "todo", name: state },
    team: {
      id: "team-1",
      states: [
        { id: "todo", name: "Todo", type: "unstarted" },
        { id: "progress", name: "In Progress", type: "started" },
        { id: "action", name: "Needs My Action", type: "started" },
        { id: "review", name: "In Review", type: "started" },
      ],
    },
    project: { id: "project-1", name: "Pilot" },
  };
}

const event: WorkEvent = {
  deliveryId: "delivery-1",
  source: "linear",
  receivedAt: "2026-07-13T12:00:00.000Z",
  payload: {
    action: "create",
    type: "Issue",
    data: { id: "issue-1" },
    webhookTimestamp: Date.now(),
  },
};

function modelResult<T>(value: T): ModelResult<T> {
  return {
    value,
    rawText: JSON.stringify(value),
    providerRequestId: "request-1",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      estimatedCostMicros: 100,
      pricing: { inputPerToken: 0.000001, outputPerToken: 0.000002 },
    },
  };
}

function harness(currentIssue: LinearIssue, route: RouteDecision, execution?: ExecutionResult) {
  const transitions: string[] = [];
  const comments: string[] = [];
  const repository: WorkerRepository = {
    claim: vi.fn().mockResolvedValue("claimed"),
    getCompletedGeneration: vi.fn().mockResolvedValue(null),
    startGeneration: vi.fn().mockResolvedValue(undefined),
    completeGeneration: vi.fn().mockResolvedValue(undefined),
    failGeneration: vi.fn().mockResolvedValue(undefined),
    assertWithinBudget: vi.fn().mockResolvedValue(undefined),
    completeTask: vi.fn().mockResolvedValue(undefined),
    failTask: vi.fn().mockResolvedValue(undefined),
  };
  const linear: LinearClient = {
    getIssue: vi.fn().mockResolvedValue(currentIssue),
    moveIssue: vi.fn(async (target, state) => {
      transitions.push(state);
      target.state.name = state;
    }),
    addComment: vi.fn(async (_id, body) => { comments.push(body); }),
  };
  const ai: AiGatewayClient = {
    route: vi.fn().mockResolvedValue(modelResult(route)),
    execute: vi.fn().mockResolvedValue(modelResult(execution)),
  };
  return {
    service: new OrchestratorWorkerService(config, repository, linear, ai),
    repository,
    ai,
    transitions,
    comments,
  };
}

describe("OrchestratorWorkerService", () => {
  it("routes complex work to GLM-5.2 and leaves a candidate in review", async () => {
    const h = harness(
      issue(),
      { complexity: "complex", outcome: "execute", reason: "Requires deeper synthesis" },
      { outcome: "ready_for_review", summary: "Draft prepared", result: "Candidate output", verification: ["Check wording"] },
    );

    await expect(h.service.handle(event)).resolves.toEqual({ outcome: "in_review" });
    expect(h.ai.execute).toHaveBeenCalledWith(expect.anything(), expect.anything(), "zai/glm-5.2");
    expect(h.transitions).toEqual(["In Progress", "In Review"]);
    expect(h.comments[0]).toContain("candidate result awaiting human review");
    expect(h.repository.completeGeneration).toHaveBeenCalledTimes(2);
  });

  it("hands blocked work to Needs My Action without calling the executor", async () => {
    const h = harness(issue(), {
      complexity: "simple",
      outcome: "needs_human",
      reason: "Approval is missing",
      humanAction: "Approve the rollout",
    });

    await expect(h.service.handle(event)).resolves.toMatchObject({ outcome: "needs_action" });
    expect(h.ai.execute).not.toHaveBeenCalled();
    expect(h.transitions).toEqual(["In Progress", "Needs My Action"]);
    expect(h.comments[0]).toContain("Approve the rollout");
  });

  it("ignores a stale delivery when the issue is no longer Todo", async () => {
    const h = harness(issue("In Progress"), {
      complexity: "simple",
      outcome: "execute",
      reason: "Simple",
    });

    await expect(h.service.handle(event)).resolves.toEqual({
      outcome: "ignored",
      reason: "Current state is In Progress",
    });
    expect(h.repository.claim).not.toHaveBeenCalled();
    expect(h.ai.route).not.toHaveBeenCalled();
  });
});
