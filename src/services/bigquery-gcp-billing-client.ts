import type { GcpBillingClient, GcpBillingMonthResult } from "./gcp-billing-client.js";

interface QueryOptions {
  query: string;
  params: Record<string, string>;
  location: string;
  maximumBytesBilled: string;
  useLegacySql: false;
}

export interface BigQueryRunner {
  query(options: QueryOptions): Promise<[Array<Record<string, unknown>>]>;
}

export interface BigQueryBillingConfig {
  table: string;
  location: string;
  projectId: string;
  maximumBytesBilled: number;
}

const CANONICAL_BUDGET_CURRENCY = "USD";

function scalar(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (value && typeof value === "object" && "value" in value) {
    return Number((value as { value: unknown }).value);
  }
  return Number.NaN;
}

function monthWindow(month: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error("month must use YYYY-MM format");
  }
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function validateConfig(config: BigQueryBillingConfig): void {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(config.table)) {
    throw new Error("GCP_BILLING_TABLE must be project.dataset.table");
  }
  if (!config.projectId) throw new Error("GCP_BILLING_PROJECT_FILTER is required");
  if (!Number.isSafeInteger(config.maximumBytesBilled) || config.maximumBytesBilled <= 0) {
    throw new Error("GCP_BILLING_MAX_BYTES_BILLED must be greater than zero");
  }
}

export class BigQueryGcpBillingClient implements GcpBillingClient {
  constructor(
    private readonly bigQuery: BigQueryRunner,
    private readonly config: BigQueryBillingConfig,
  ) {}

  async getMonth(month: string): Promise<GcpBillingMonthResult> {
    validateConfig(this.config);
    const { start, end } = monthWindow(month);
    const [rows] = await this.bigQuery.query({
      query: `
        SELECT
          COALESCE(SUM(CAST(cost * 1000000 AS INT64)), 0)
            + COALESCE(SUM(IFNULL((
              SELECT SUM(CAST(credit.amount * 1000000 AS INT64))
              FROM UNNEST(credits) AS credit
            ), 0)), 0) AS costMicros,
          ANY_VALUE(currency) AS currency,
          COUNT(DISTINCT currency) AS currencyCount,
          COUNT(*) AS rowCount
        FROM \`${this.config.table}\`
        WHERE project.id = @projectId
          AND usage_start_time >= TIMESTAMP(@start)
          AND usage_start_time < TIMESTAMP(@end)
          AND _PARTITIONTIME >= TIMESTAMP(@start)
      `,
      params: { projectId: this.config.projectId, start, end },
      location: this.config.location,
      maximumBytesBilled: String(this.config.maximumBytesBilled),
      useLegacySql: false,
    });
    const row = rows[0] ?? {};
    const costMicros = scalar(row.costMicros);
    const rowCount = scalar(row.rowCount);
    const currencyCount = scalar(row.currencyCount);
    if (
      !Number.isSafeInteger(costMicros) ||
      !Number.isSafeInteger(rowCount) ||
      !Number.isSafeInteger(currencyCount)
    ) {
      throw new Error("BigQuery returned invalid aggregate values");
    }

    if (rowCount > 0 && currencyCount !== 1) {
      throw new Error("Google Cloud billing returned an unknown or mixed currency set");
    }

    const currency = rowCount === 0
      ? CANONICAL_BUDGET_CURRENCY
      : typeof row.currency === "string" && row.currency.trim()
        ? row.currency.trim().toUpperCase()
        : "";
    if (!currency) {
      throw new Error("Google Cloud billing currency is required before aggregation");
    }
    if (currency !== CANONICAL_BUDGET_CURRENCY) {
      throw new Error(
        `Google Cloud billing currency ${currency} must be normalized to ${CANONICAL_BUDGET_CURRENCY} before aggregation`,
      );
    }

    return {
      costMicros: Math.max(0, costMicros),
      currency,
      rowCount,
      table: this.config.table,
      projectId: this.config.projectId,
      queryStart: start,
      queryEnd: end,
    };
  }
}
