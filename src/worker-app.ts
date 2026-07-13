import express, { type Express } from "express";
import type { OrchestratorWorkerService } from "./services/orchestrator-worker-service.js";
import type { VercelCostReconciliationService } from "./services/vercel-cost-reconciliation-service.js";
import { decodeWorkEvent, parsePubSubEnvelope } from "./types/worker.js";

export function createWorkerApp(
  worker: OrchestratorWorkerService,
  reconciliation?: VercelCostReconciliationService,
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

  app.post("/internal/reconcile/vercel", async (_request, response) => {
    if (!reconciliation) {
      response.status(503).json({ error: "reconciliation is not configured" });
      return;
    }
    try {
      response.status(200).json(await reconciliation.reconcile());
    } catch (error) {
      console.error("Vercel cost reconciliation failed", error);
      response.status(502).json({ error: "Vercel cost reconciliation failed" });
    }
  });

  return app;
}
