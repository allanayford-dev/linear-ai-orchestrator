import type { LinearIssue } from "../types/worker.js";

export function normalizeLinearState(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function linearStateType(issue: LinearIssue): string {
  if (issue.state.type) return issue.state.type;
  return issue.team.states.find((state) => state.id === issue.state.id)?.type ??
    "unknown";
}
