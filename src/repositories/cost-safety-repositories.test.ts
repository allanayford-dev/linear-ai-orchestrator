import { describe, expect, it, vi } from "vitest";
import type { Firestore } from "@google-cloud/firestore";
import { AuditedDashboardRepository } from "./audited-dashboard-repository.js";
import { PauseAwareWorkerRepository } from "./pause-aware-worker-repository.js";
import type { DashboardRepository } from "./dashboard-repository.js";
import type { WorkerRepository } from "./worker-repository.js";
import type { LinearIssue } from "../types/worker.js";

const issue: LinearIssue = {
  id: "issue-1",
  identifier: "ALL-255",
  title: "Cost safety",
  description: null,
  url: "https://linear.app/issue/ALL-255",
  state: { id: "todo", name: "Todo" },
  team: { id: "team-1", states: [] },
  project: { id: "project-1", name: "Linear AI Orchestrator" },
  labels: [],
};

function pauseFirestore(paused: boolean) {
  const controlSnapshot = { get: vi.fn((field: string) => field === "paused" ? paused : undefined) };
  const controlRef = { get: vi.fn().mockResolvedValue(controlSnapshot) };
  const firestore = {
    collection: vi.fn().mockReturnValue({
      doc: vi.fn().mockReturnValue(controlRef),
    }),
  } as unknown as Firestore;
  return firestore;
}

describe("PauseAwareWorkerRepository", () => {
  it("blocks a new claim while preserving the outer webhook/state-sync path", async () => {
    const inner = {
      claim: vi.fn().mockResolvedValue("claimed"),
    } as unknown as WorkerRepository;
    const repository = new PauseAwareWorkerRepository(pauseFirestore(true), inner);

    await expect(repository.claim(
      issue,
      {
        deliveryId: "delivery-1",
        deliveryAttempt: 1,
        pubsubMessageId: "message-1",
        subscription: null,
      },
      900,
      5,
      true,
    )).resolves.toBe("busy");

    expect(inner.claim).not.toHaveBeenCalled();
  });

  it("allows an existing In Progress delivery to resume while manually paused", async () => {
    const inner = {
      claim: vi.fn().mockResolvedValue("recovered"),
    } as unknown as WorkerRepository;
    const repository = new PauseAwareWorkerRepository(pauseFirestore(true), inner);

    await expect(repository.claim(
      issue,
      {
        deliveryId: "delivery-1",
        deliveryAttempt: 2,
        pubsubMessageId: "message-2",
        subscription: null,
      },
      900,
      5,
      false,
    )).resolves.toBe("recovered");

    expect(inner.claim).toHaveBeenCalledOnce();
  });
});

describe("AuditedDashboardRepository", () => {
  it("records a manual pause action and completion evidence", async () => {
    const auditSet = vi.fn().mockResolvedValue(undefined);
    const before = {
      get: vi.fn((field: string) => ({
        paused: false,
        paidAiPaused: false,
        budgetMicros: 20_000_000,
        paidAiCircuitBreakerMicros: 18_000_000,
        thresholds: [50, 75, 90, 100],
      } as Record<string, unknown>)[field]),
    };
    const controlRef = { get: vi.fn().mockResolvedValue(before) };
    const auditRef = { set: auditSet };
    const firestore = {
      collection: vi.fn((name: string) => ({
        doc: vi.fn().mockReturnValue(
          name === "orchestrator_control" ? controlRef : auditRef,
        ),
      })),
    } as unknown as Firestore;
    const inner = {
      updateBudget: vi.fn().mockResolvedValue(undefined),
    } as unknown as DashboardRepository;
    const repository = new AuditedDashboardRepository(firestore, inner);

    await repository.updateBudget({
      budgetMicros: 20_000_000,
      paidAiCircuitBreakerMicros: 18_000_000,
      thresholds: [50, 75, 90, 100],
      paused: true,
      pauseReason: "Manual safety pause",
    }, "allan@allanayford.me");

    expect(auditSet).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "pause",
      actor: "allan@allanayford.me",
      status: "pending",
      previousPaused: false,
      requestedPaused: true,
    }));
    expect(auditSet).toHaveBeenNthCalledWith(2, expect.objectContaining({
      status: "complete",
    }), { merge: true });
  });
});
