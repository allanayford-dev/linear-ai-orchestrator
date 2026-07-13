import express, { type NextFunction, type Request, type Response } from "express";
import type { AppConfig } from "./config/env.js";
import { LinearWebhookService } from "./services/linear-webhook-service.js";
import {
  isWebhookTimestampCurrent,
  verifyLinearSignature,
} from "./services/webhook-auth.js";
import { parseLinearWebhookPayload } from "./types/linear.js";

export interface AppDependencies {
  config: AppConfig;
  webhookService: LinearWebhookService;
  now?: () => number;
}

export function createApp({ config, webhookService, now = Date.now }: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok", service: "linear-webhook" });
  });

  app.post(
    "/webhooks/linear",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (request: Request, response: Response, next: NextFunction) => {
      try {
        if (!Buffer.isBuffer(request.body)) {
          response.status(415).json({ error: "application/json body required" });
          return;
        }

        const signature = request.header("linear-signature");
        if (
          !verifyLinearSignature(
            config.linearWebhookSecret,
            request.body,
            signature,
          )
        ) {
          response.status(401).json({ error: "invalid webhook signature" });
          return;
        }

        const payload = parseLinearWebhookPayload(
          JSON.parse(request.body.toString("utf8")) as unknown,
        );
        if (
          !isWebhookTimestampCurrent(
            payload.webhookTimestamp,
            now(),
            config.linearWebhookToleranceMs,
          )
        ) {
          response.status(401).json({ error: "stale webhook timestamp" });
          return;
        }

        const deliveryId = request.header("linear-delivery");
        if (!deliveryId) {
          response.status(400).json({ error: "linear-delivery header required" });
          return;
        }

        const result = await webhookService.handle(deliveryId, payload);
        response.status(200).json({ accepted: true, ...result });
      } catch (error) {
        next(error);
      }
    },
  );

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(JSON.stringify({ severity: "ERROR", message }));
      response.status(500).json({ error: "internal server error" });
    },
  );

  return app;
}
