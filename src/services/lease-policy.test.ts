import { describe, expect, it } from "vitest";
import { decideLeaseClaim } from "./lease-policy.js";

const request = {
  deliveryId: "delivery-new",
  deliveryAttempt: 2,
  maxDeliveryAttempts: 5,
  allowNewClaim: false,
  nowMs: 10_000,
};

describe("decideLeaseClaim", () => {
  it("blocks a different delivery while the lease is active", () => {
    expect(decideLeaseClaim({
      currentDeliveryId: "delivery-old",
      leaseUntilMs: 11_000,
    }, request)).toBe("busy");
  });

  it("resumes the same delivery and preserves completion idempotency", () => {
    expect(decideLeaseClaim({ currentDeliveryId: "delivery-new" }, request))
      .toBe("claimed");
    expect(decideLeaseClaim({ completedDeliveryId: "delivery-new" }, request))
      .toBe("duplicate");
  });

  it("recovers an expired lease for an issue already in progress", () => {
    expect(decideLeaseClaim({
      currentDeliveryId: "delivery-old",
      leaseUntilMs: 9_000,
      orchestrationStatus: "claimed",
    }, request)).toBe("recovered");
  });

  it("treats a deliberate Todo retry after completion as a fresh claim", () => {
    expect(decideLeaseClaim({
      completedDeliveryId: "delivery-old",
      currentDeliveryId: "delivery-old",
      orchestrationStatus: "in_review",
    }, { ...request, allowNewClaim: true })).toBe("claimed");
  });

  it("stops processing at the configured delivery limit", () => {
    expect(decideLeaseClaim({}, {
      ...request,
      deliveryAttempt: 5,
      allowNewClaim: true,
    })).toBe("delivery_limit");
  });
});
