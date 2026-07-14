import { describe, expect, it } from "vitest";
import type { LinearIssue } from "../types/worker.js";
import { linearStateType, normalizeLinearState } from "./linear-state-policy.js";

describe("linear state policy", () => {
  it("normalizes configured and custom state names", () => {
    expect(normalizeLinearState("Needs My Action")).toBe("needs_my_action");
    expect(normalizeLinearState("  In Review  ")).toBe("in_review");
    expect(normalizeLinearState("QA / Customer Sign-off")).toBe("qa_customer_sign_off");
  });

  it("uses the canonical state type or falls back to team states", () => {
    const issue = {
      state: { id: "done", name: "Done" },
      team: { states: [{ id: "done", name: "Done", type: "completed" }] },
    } as LinearIssue;
    expect(linearStateType(issue)).toBe("completed");
    issue.state.type = "canceled";
    expect(linearStateType(issue)).toBe("canceled");
  });
});
