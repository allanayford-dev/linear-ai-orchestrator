import { randomUUID } from "node:crypto";
import type { GcpCostRepository } from "../repositories/gcp-cost-repository.js";
import { validMonth } from "./budget-policy.js";
import type { GcpBillingClient, GcpBillingMonthResult } from "./gcp-billing-client.js";

export class GcpCostReconciliationService {
  constructor(
    private readonly client: GcpBillingClient,
    private readonly repository: GcpCostRepository,
    private readonly table: string,
    private readonly projectId: string,
  ) {}

  async reconcile(month: string): Promise<GcpBillingMonthResult & { attemptId: string }> {
    if (!validMonth(month)) throw new Error("month must use YYYY-MM format");
    const attemptId = randomUUID();
    try {
      const result = await this.client.getMonth(month);
      await this.repository.complete({ attemptId, month, ...result });
      return { attemptId, ...result };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await this.repository.fail(attemptId, month, this.table, this.projectId, failure);
      throw failure;
    }
  }
}
