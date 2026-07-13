interface ReportRow {
  total_cost?: number | string;
  request_count?: number | string;
}

interface ReportResponse {
  results?: ReportRow[];
  error?: { message?: string };
  message?: string;
}

export interface VercelSpendReport {
  totalCostMicros: number;
  requestCount: number;
}

function finiteNumber(value: unknown, field: string): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
    throw new Error(`Vercel report returned an invalid ${field}`);
  }
  return number;
}

export class VercelReportError extends Error {
  override readonly name = "VercelReportError";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class VercelReportClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://ai-gateway.vercel.sh/v1",
  ) {}

  async getSpend(startDate: string, endDate: string): Promise<VercelSpendReport> {
    const query = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      group_by: "day",
    });
    const response = await fetch(`${this.baseUrl}/report?${query}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "X-Vercel-AI-Gateway-User-Agent": "linear-ai-orchestrator/0.1.0",
      },
    });
    const body = (await response.json().catch(() => ({}))) as ReportResponse;
    if (!response.ok) {
      const message = body.error?.message || body.message ||
        `Vercel reporting failed with HTTP ${response.status}`;
      throw new VercelReportError(message, response.status);
    }
    if (!Array.isArray(body.results)) {
      throw new Error("Vercel report response did not contain results");
    }
    const totals = body.results.reduce((sum, row) => ({
      cost: sum.cost + finiteNumber(row.total_cost ?? 0, "total_cost"),
      requests: sum.requests + finiteNumber(row.request_count ?? 0, "request_count"),
    }), { cost: 0, requests: 0 });
    return {
      totalCostMicros: Math.round(totals.cost * 1_000_000),
      requestCount: Math.round(totals.requests),
    };
  }
}
