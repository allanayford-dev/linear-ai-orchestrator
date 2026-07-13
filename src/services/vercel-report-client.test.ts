import { afterEach, describe, expect, it, vi } from "vitest";
import { VercelReportClient, VercelReportError } from "./vercel-report-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("VercelReportClient", () => {
  it("aggregates actual cost and request count", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [
        { total_cost: 0.05, request_count: 10 },
        { total_cost: "0.00761836", request_count: "1" },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new VercelReportClient("key");
    await expect(client.getSpend("2026-07-01", "2026-07-13")).resolves.toEqual({
      totalCostMicros: 57_618,
      requestCount: 11,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("start_date=2026-07-01"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer key" }) }),
    );
  });

  it("preserves reporting API errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "Custom Reporting is not enabled" },
    }), { status: 403 })));
    const client = new VercelReportClient("key");
    await expect(client.getSpend("2026-07-01", "2026-07-13"))
      .rejects.toEqual(expect.objectContaining<VercelReportError>({
        name: "VercelReportError",
        status: 403,
        message: "Custom Reporting is not enabled",
      }));
  });
});
