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
import type { LinearClient } from "./linear-client.js";
import type { ModelClient } from "./model-client.js";
import { RetryableProviderError } from "./provider-errors.js";
import { OrchestratorWorkerService } from "./orchestrator-worker-service.js";

const config: WorkerConfig = {
  port: 8080,
  databaseId: "(default)",
  linearApiKey: "linear-key",
  aiGatewayApiKey: "gateway-key",
  geminiApiKey: "gemini-key",
  geminiModel: "gemini-3.1-flash-lite",
  geminiAllowedProjects: ["Pilot"],
  geminiSensitiveLabels: ["ai-sensitive"],
  routerModel: "zai/glm-4.7-flashx",
  executorModel: "zai/glm-5.2",
  states: { todo: "Todo", inProgress: "In Progress", needsAction: "Needs My Action", review: "In Review" },
  leaseSeconds: 900,
  maxTaskCostMicros: 250_000,
  maxTaskTokens: 50_000,
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
    labels: [],
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
      reasoningTokens: 0,
      totalTokens: 150,
      estimatedCostMicros: 100,
      pricing: { inputPerToken: 0.000001, outputPerToken: 0.000002 },
    },
  };
}

function harness(
  currentIssue: LinearIssue,
  route: RouteDecision,
  execution?: ExecutionResult,
  claimResult: "claimed" | "duplicate" | "busy" = "claimed",
) {
  const transitions: string[] = [];
  const comments: string[] = [];
  const repository: WorkerRepository = {
    claim: vi.fn().mockResolvedValue(claimResult),
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
  const gemini: ModelClient = {
    route: vi.fn().mockResolvedValue(modelResult(route)),
    execute: vi.fn().mockResolvedValue(modelResult(execution)),
  };
  const paidAi: ModelClient = {
    route: vi.fn().mockResolvedValue(modelResult(route)),
    execute: vi.fn().mockResolvedValue(modelResult(execution)),
  };
  return {
    service: new OrchestratorWorkerService(
      config,
      repository,
      linear,
      gemini,
      paidAi,
    ),
    repository,
    gemini,
    paidAi,
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
    expect(h.gemini.route).toHaveBeenCalledWith(expect.anything(), "gemini-3.1-flash-lite");
    expect(h.paidAi.execute).toHaveBeenCalledWith(expect.anything(), expect.anything(), "zai/glm-5.2");
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
    expect(h.gemini.execute).not.toHaveBeenCalled();
    expect(h.paidAi.execute).not.toHaveBeenCalled();
    expect(h.transitions).toEqual(["In Progress", "Needs My Action"]);
    expect(h.comments[0]).toContain("Approve the rollout");
  });

  it("acknowledges provider account failures as Needs My Action", async () => {
    const h = harness(issue(), {
      complexity: "simple",
      outcome: "execute",
      reason: "Simple",
    });
    const providerError = new Error("A valid credit card is required");
    providerError.name = "ProviderConfigurationError";
    vi.mocked(h.gemini.route).mockRejectedValue(providerError);

    await expect(h.service.handle(event)).resolves.toMatchObject({ outcome: "needs_action" });
    expect(h.transitions).toEqual(["In Progress", "Needs My Action"]);
    expect(h.comments[0]).toContain("payment configuration is incomplete");
    expect(h.repository.failTask).not.toHaveBeenCalled();
  });

  it("ignores a stale delivery when the issue is no longer Todo", async () => {
    const h = harness(issue("In Progress"), {
      complexity: "simple",
      outcome: "execute",
      reason: "Simple",
    }, undefined, "busy");

    await expect(h.service.handle(event)).resolves.toEqual({
      outcome: "busy",
    });
    expect(h.repository.claim).toHaveBeenCalledWith(expect.anything(), "delivery-1", 900, false);
    expect(h.gemini.route).not.toHaveBeenCalled();
  });

  it("uses free Gemini for both calls on eligible simple work", async () => {
    const h = harness(
      issue(),
      { complexity: "simple", outcome: "execute", reason: "Short drafting task" },
      { outcome: "ready_for_review", summary: "Drafted", result: "Result", verification: [] },
    );

    await expect(h.service.handle(event)).resolves.toEqual({ outcome: "in_review" });
    expect(h.gemini.route).toHaveBeenCalledTimes(1);
    expect(h.gemini.execute).toHaveBeenCalledTimes(1);
    expect(h.paidAi.route).not.toHaveBeenCalled();
    expect(h.paidAi.execute).not.toHaveBeenCalled();
    expect(h.comments[0]).toContain("google-gemini/gemini-3.1-flash-lite (free)");
  });

  it("falls back once to paid GLM when Gemini is temporarily unavailable", async () => {
    const h = harness(
      issue(),
      { complexity: "simple", outcome: "execute", reason: "Simple" },
      { outcome: "ready_for_review", summary: "Recovered", result: "Result", verification: [] },
    );
    vi.mocked(h.gemini.route).mockRejectedValue(
      new RetryableProviderError("Quota exhausted", "google-gemini", 429),
    );

    await expect(h.service.handle(event)).resolves.toEqual({ outcome: "in_review" });
    expect(h.gemini.route).toHaveBeenCalledTimes(1);
    expect(h.paidAi.route).toHaveBeenCalledTimes(1);
    expect(h.gemini.execute).not.toHaveBeenCalled();
    expect(h.paidAi.execute).toHaveBeenCalledTimes(1);
    expect(h.repository.startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google-gemini", role: "router", attempt: 1 }),
    );
    expect(h.repository.startGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "vercel-ai-gateway", role: "router", attempt: 2 }),
    );
  });

  it("keeps sensitive work away from the Gemini free tier", async () => {
    const sensitiveIssue = issue();
    sensitiveIssue.labels = [{ id: "label-1", name: "ai-sensitive" }];
    const h = harness(
      sensitiveIssue,
      { complexity: "simple", outcome: "execute", reason: "Simple" },
      { outcome: "ready_for_review", summary: "Done", result: "Result", verification: [] },
    );

    await expect(h.service.handle(event)).resolves.toEqual({ outcome: "in_review" });
    expect(h.gemini.route).not.toHaveBeenCalled();
    expect(h.gemini.execute).not.toHaveBeenCalled();
    expect(h.paidAi.route).toHaveBeenCalledTimes(1);
    expect(h.paidAi.execute).toHaveBeenCalledTimes(1);
  });

  it("resumes the original delivery without changing In Progress again", async () => {
    const h = harness(
      issue("In Progress"),
      { complexity: "simple", outcome: "execute", reason: "Retry" },
      { outcome: "ready_for_review", summary: "Recovered", result: "Result", verification: [] },
    );

    await expect(h.service.handle(event)).resolves.toEqual({ outcome: "in_review" });
    expect(h.transitions).toEqual(["In Review"]);
    expect(h.repository.claim).toHaveBeenCalledWith(expect.anything(), "delivery-1", 900, false);
  });
});
