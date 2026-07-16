import { describe, expect, it } from "vitest";
import {
  REPOSITORY_TARGETS,
  resolveRepositoryTarget,
} from "./repository-target-policy.js";

describe("repository target policy", () => {
  it("maps AYFORD Finance Monitor", () => {
    expect(resolveRepositoryTarget({
      id: "158874b7-8695-4db0-9199-145f4716c7d6",
      name: "AYFORD Finance Monitor",
    })).toMatchObject({
      repositoryFullName: "allanayford-dev/ayford-finance-monitor",
      baseBranch: "develop",
    });
  });

  it("maps Portfolio Mini Mobile App", () => {
    expect(resolveRepositoryTarget({
      id: "b3618e27-2082-49b3-bd64-4f5abac00b25",
      name: "Portfolio Mini Mobile App",
    })).toMatchObject({
      repositoryFullName: "allanayford-dev/portfolio-mini-mobile-app",
      baseBranch: "develop",
    });
  });

  it("uses the project name as a controlled fallback", () => {
    expect(resolveRepositoryTarget({
      id: "changed-project-id",
      name: "AYFORD Finance Monitor",
    })?.repositoryFullName).toBe("allanayford-dev/ayford-finance-monitor");
  });

  it("fails closed for an unmapped project", () => {
    expect(resolveRepositoryTarget(null)).toBeNull();
    expect(resolveRepositoryTarget({ id: "other", name: "Other Project" }))
      .toBeNull();
  });

  it("defines structured validation commands for every mapped project", () => {
    for (const target of REPOSITORY_TARGETS) {
      expect(target.validationCommands.length).toBeGreaterThan(0);
      expect(target.validationCommands.every((command) => command.executable === "pnpm"))
        .toBe(true);
    }
  });
});
