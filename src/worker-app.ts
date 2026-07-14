import express, { type Express } from "express";
import type { OrchestratorWorkerService } from "./services/orchestrator-worker-service.js";
import type { DeadLetterService } from "./services/dead-letter-service.js";
import { decodeWorkEvent, parsePubSubEnvelope } from "./types/worker.js";

export function createWorkerApp(
  worker: OrchestratorWorkerService,
  deadLetters: DeadLetterService,
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

  return app;
}
