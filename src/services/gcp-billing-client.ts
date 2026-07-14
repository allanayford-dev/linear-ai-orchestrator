export interface GcpBillingMonthResult {
  costMicros: number;
  currency: string;
  rowCount: number;
  table: string;
  projectId: string;
  queryStart: string;
  queryEnd: string;
}

export interface GcpBillingClient {
  getMonth(month: string): Promise<GcpBillingMonthResult>;
}
