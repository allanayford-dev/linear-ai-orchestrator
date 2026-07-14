import type { ClaimResult } from "../repositories/worker-repository.js";

export interface LeaseState {
  completedDeliveryId?: string;
  currentDeliveryId?: string;
  leaseUntilMs?: number;
  orchestrationStatus?: string;
}

export interface LeaseRequest {
  deliveryId: string;
  deliveryAttempt: number;
  maxDeliveryAttempts: number;
  allowNewClaim: boolean;
  nowMs: number;
}

export function decideLeaseClaim(
  state: LeaseState,
  request: LeaseRequest,
): ClaimResult {
  if (state.completedDeliveryId === request.deliveryId) return "duplicate";
  if (request.deliveryAttempt >= request.maxDeliveryAttempts) {
    return "delivery_limit";
  }
  if (state.currentDeliveryId === request.deliveryId) return "claimed";
  if (state.leaseUntilMs && state.leaseUntilMs > request.nowMs) return "busy";
  const recoverableStatus = state.orchestrationStatus === "claimed" ||
    state.orchestrationStatus === "retryable_error" ||
    state.orchestrationStatus === "stale_recovered";
  if (state.currentDeliveryId && recoverableStatus) return "recovered";
  return request.allowNewClaim ? "claimed" : "busy";
}
