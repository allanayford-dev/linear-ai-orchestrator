export interface GcpCostReconciliation {
  attemptId: string;
  month: string;
  costMicros: number;
  currency: string;
  rowCount: number;
  table: string;
  projectId: string;
  queryStart: string;
  queryEnd: string;
}

export interface GcpCostRepository {
  complete(reconciliation: GcpCostReconciliation): Promise<void>;
  fail(
    attemptId: string,
    month: string,
    table: string,
    projectId: string,
    error: Error,
  ): Promise<void>;
}
