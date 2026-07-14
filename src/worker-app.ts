import express, { type Express } from "express";
import type { OrchestratorWorkerService } from "./services/orchestrator-worker-service.js";
import type { DeadLetterService } from "./services/dead-letter-service.js";
import type { GcpCostReconciliationService } from "./services/gcp-cost-reconciliation-service.js";
import { currentMonth } from "./services/budget-policy.js";
import { decodeWorkEvent, parsePubSubEnvelope } from "./types/worker.js";

export function createWorkerApp(
  worker: OrchestratorWorkerService,
  deadLetters: DeadLetterService,
  gcpCosts: GcpCostReconciliationService,
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok", service: "orchestrator-worker" });
  });

  app.post("/pubsub/push", async (request, response) => {
    let event;
    try {
      const envelope = parsePubSubEnvelope(request.body);
      event = decodeWorkEvent(envelope);
    } catch (error) {
      // Poison messages cannot succeed on retry. Log and acknowledge them so
      // they do not consume the subscription forever.
      console.error("Discarding invalid Pub/Sub delivery", error);
      response.status(204).set("X-Orchestrator-Outcome", "invalid").send();
      return;
    }
    try {
      const result = await worker.handle(event);
      response.status(204).set("X-Orchestrator-Outcome", result.outcome).send();
    } catch (error) {
      console.error("Worker delivery failed", error);
      response.status(500).json({ error: "delivery failed" });
    }
  });

  app.post("/pubsub/dead-letter", async (request, response) => {
    try {
      const outcome = await deadLetters.record(request.body);
      response.status(204).set("X-Orchestrator-Outcome", outcome).send();
    } catch (error) {
      console.error("Dead-letter persistence failed", error);
      response.status(500).json({ error: "dead-letter persistence failed" });
    }
  });

  app.post("/internal/reconcile/gcp", async (request, response) => {
    const month = typeof request.query.month === "string"
      ? request.query.month
      : currentMonth();
    try {
      response.status(200).json(await gcpCosts.reconcile(month));
    } catch (error) {
      console.error("Google Cloud cost reconciliation failed", error);
      response.status(502).json({ error: "Google Cloud cost reconciliation failed" });
    }
  });

  app.post("/internal/reconcile/linear-states", async (request, response) => {
    const rawLimit = typeof request.query.limit === "string"
      ? Number(request.query.limit)
      : 100;
    try {
      response.status(200).json(await worker.reconcileLinearStates(rawLimit));
    } catch (error) {
      console.error("Linear state reconciliation failed", error);
      const message = error instanceof Error ? error.message : "reconciliation failed";
      response.status(message.startsWith("limit must") ? 400 : 502).json({ error: message });
    }
  });

  return app;
}
