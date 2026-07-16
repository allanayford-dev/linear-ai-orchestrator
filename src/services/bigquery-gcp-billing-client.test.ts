import { describe, expect, it, vi } from "vitest";
import {
  BigQueryGcpBillingClient,
  type BigQueryRunner,
} from "./bigquery-gcp-billing-client.js";

const config = {
  table: "glm-api-server.billing_export_eu.gcp_billing_export_v1_015AA7_5DF422_969C4D",
  location: "EU",
  projectId: "glm-api-server",
  maximumBytesBilled: 100_000_000,
};

describe("BigQueryGcpBillingClient", () => {
  it("runs a bounded, parameterized monthly project query", async () => {
    const runner = {
      query: vi.fn().mockResolvedValue([[
        { costMicros: "12500", currency: "USD", rowCount: { value: "7" } },
      ]]),
    };
    const client = new BigQueryGcpBillingClient(runner as BigQueryRunner, config);

    await expect(client.getMonth("2026-07")).resolves.toMatchObject({
      costMicros: 12_500,
      rowCount: 7,
      currency: "USD",
      queryStart: "2026-07-01T00:00:00.000Z",
      queryEnd: "2026-08-01T00:00:00.000Z",
    });
    expect(runner.query).toHaveBeenCalledWith(expect.objectContaining({
      location: "EU",
      maximumBytesBilled: "100000000",
      params: expect.objectContaining({ projectId: "glm-api-server" }),
      useLegacySql: false,
    }));
    expect(runner.query.mock.calls[0][0].query).toContain("_PARTITIONTIME >=");
  });

  it("fails closed when Google Cloud billing is not in canonical USD", async () => {
    const runner = {
      query: vi.fn().mockResolvedValue([[
        { costMicros: "12500", currency: "ZAR", rowCount: { value: "7" } },
      ]]),
    };
    const client = new BigQueryGcpBillingClient(runner as BigQueryRunner, config);

    await expect(client.getMonth("2026-07")).rejects.toThrow(
      "billing currency ZAR must be normalized to USD before aggregation",
    );
  });

  it("rejects malformed table configuration before querying", async () => {
    const runner = { query: vi.fn() };
    const client = new BigQueryGcpBillingClient(runner as BigQueryRunner, {
      ...config,
      table: "not a table; DROP TABLE",
    });
    await expect(client.getMonth("2026-07")).rejects.toThrow("project.dataset.table");
    expect(runner.query).not.toHaveBeenCalled();
  });
});
