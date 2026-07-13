import { join } from "node:path";
import express, { type Express } from "express";
import type { FirebaseWebConfig } from "./config/dashboard-env.js";
import {
  dashboardAuth,
  type AuthenticatedRequest,
  type TokenVerifier,
} from "./services/dashboard-auth.js";
import { currentMonth } from "./services/budget-policy.js";
import type { DashboardService } from "./services/dashboard-service.js";

export interface DashboardAppOptions {
  service: DashboardService;
  verifier: TokenVerifier;
  allowedEmails: string[];
  firebase: FirebaseWebConfig;
  staticDirectory?: string;
}

function actor(request: AuthenticatedRequest): string {
  return request.dashboardUser?.email ?? "unknown";
}

export function createDashboardApp(options: DashboardAppOptions): Express {
  const app = express();
  const staticDirectory = options.staticDirectory ??
    join(process.cwd(), "dist", "dashboard-public");
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(express.json({ limit: "128kb" }));

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok", service: "orchestrator-dashboard" });
  });
  app.get("/api/config", (_request, response) => {
    response.status(200).json({ firebase: options.firebase });
  });

  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", dashboardAuth(options.verifier, options.allowedEmails));

  app.get("/api/dashboard", async (request: AuthenticatedRequest, response) => {
    try {
      const month = typeof request.query.month === "string"
        ? request.query.month
        : currentMonth();
      response.status(200).json(await options.service.getDashboard(month));
    } catch (error) {
      response.status(400).json({ error: (error as Error).message });
    }
  });

  app.put("/api/budget", async (request: AuthenticatedRequest, response) => {
    try {
      await options.service.updateBudget(request.body, actor(request));
      response.status(204).send();
    } catch (error) {
      response.status(400).json({ error: (error as Error).message });
    }
  });

  app.put("/api/external-costs/:month", async (
    request: AuthenticatedRequest,
    response,
  ) => {
    try {
      await options.service.updateExternalCosts(
        typeof request.params.month === "string" ? request.params.month : "",
        request.body,
        actor(request),
      );
      response.status(204).send();
    } catch (error) {
      response.status(400).json({ error: (error as Error).message });
    }
  });

  app.use(express.static(staticDirectory, {
    etag: true,
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  }));
  app.get("/", (_request, response) => {
    response.sendFile(join(staticDirectory, "index.html"));
  });
  return app;
}
