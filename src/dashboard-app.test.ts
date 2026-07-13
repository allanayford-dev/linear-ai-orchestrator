import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createDashboardApp } from "./dashboard-app.js";
import type { DashboardService } from "./services/dashboard-service.js";

function app(overrides: { allowedEmails?: string[] } = {}) {
  const service = {
    getDashboard: vi.fn().mockResolvedValue({ month: "2026-07" }),
    updateBudget: vi.fn().mockResolvedValue(undefined),
    updateExternalCosts: vi.fn().mockResolvedValue(undefined),
  };
  const verifier = {
    verifyIdToken: vi.fn().mockResolvedValue({
      uid: "user-1",
      email: "owner@example.com",
      name: "Owner",
    }),
  };
  return {
    app: createDashboardApp({
      service: service as unknown as DashboardService,
      verifier: verifier as never,
      allowedEmails: overrides.allowedEmails ?? ["owner@example.com"],
      firebase: {
        apiKey: "public-key",
        authDomain: "project.firebaseapp.com",
        projectId: "project",
        appId: "app-id",
      },
      staticDirectory: process.cwd(),
    }),
    service,
    verifier,
  };
}

describe("dashboard app", () => {
  it("serves health and public Firebase config", async () => {
    const fixture = app();
    await request(fixture.app).get("/health").expect(200, {
      status: "ok",
      service: "orchestrator-dashboard",
    });
    const response = await request(fixture.app).get("/api/config").expect(200);
    expect(response.body.firebase.apiKey).toBe("public-key");
  });

  it("requires and verifies Firebase authentication", async () => {
    const fixture = app();
    await request(fixture.app).get("/api/dashboard?month=2026-07").expect(401);
    await request(fixture.app)
      .get("/api/dashboard?month=2026-07")
      .set("Authorization", "Bearer valid-token")
      .expect(200, { month: "2026-07" });
    expect(fixture.verifier.verifyIdToken).toHaveBeenCalledWith("valid-token");
  });

  it("rejects signed-in users outside the email allowlist", async () => {
    const fixture = app({ allowedEmails: ["other@example.com"] });
    await request(fixture.app)
      .get("/api/dashboard?month=2026-07")
      .set("Authorization", "Bearer valid-token")
      .expect(403);
  });

  it("updates budget and external costs for the authenticated actor", async () => {
    const fixture = app();
    await request(fixture.app)
      .put("/api/budget")
      .set("Authorization", "Bearer valid-token")
      .send({ budgetMicros: 20_000_000, thresholds: [50, 90, 100], paused: false })
      .expect(204);
    expect(fixture.service.updateBudget).toHaveBeenCalledWith(
      expect.anything(),
      "owner@example.com",
    );

    await request(fixture.app)
      .put("/api/external-costs/2026-07")
      .set("Authorization", "Bearer valid-token")
      .send({ gatewayActualCostMicros: 10, gcpCostMicros: 20, otherCostMicros: 0 })
      .expect(204);
    expect(fixture.service.updateExternalCosts).toHaveBeenCalledWith(
      "2026-07",
      expect.anything(),
      "owner@example.com",
    );
  });
});
