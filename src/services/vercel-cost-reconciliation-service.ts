import type { DashboardRepository } from "../repositories/dashboard-repository.js";
import { currentMonth } from "./budget-policy.js";
import type { VercelReportClient } from "./vercel-report-client.js";

export interface ReconciliationResult {
  month: string;
  startDate: string;
  endDate: string;
  gatewayActualCostMicros: number;
  requestCount: number;
}

export class VercelCostReconciliationService {
  constructor(
    private readonly reportClient: VercelReportClient,
    private readonly repository: DashboardRepository,
  ) {}

  async reconcile(now = new Date()): Promise<ReconciliationResult> {
    const month = currentMonth(now);
    const startDate = `${month}-01`;
    const endDate = now.toISOString().slice(0, 10);
    try {
      const report = await this.reportClient.getSpend(startDate, endDate);
      await this.repository.syncGatewayCost(month, {
        gatewayActualCostMicros: report.totalCostMicros,
        requestCount: report.requestCount,
        startDate,
        endDate,
      });
      return {
        month,
        startDate,
        endDate,
        gatewayActualCostMicros: report.totalCostMicros,
        requestCount: report.requestCount,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown reporting failure";
      await this.repository.recordGatewaySyncFailure(month, message);
      throw error;
    }
  }
}
