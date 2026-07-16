export interface ValidationCommand {
  executable: "pnpm";
  args: readonly string[];
}

export interface RepositoryTarget {
  linearProjectId: string;
  linearProjectName: string;
  repositoryFullName: string;
  baseBranch: "develop";
  validationCommands: readonly ValidationCommand[];
  protectedPathPatterns: readonly string[];
}

const COMMON_PROTECTED_PATHS = [
  ".env",
  ".env.*",
  "**/*.pem",
  "**/*.key",
  "**/*service-account*.json",
  ".github/workflows/**",
  ".github/CODEOWNERS",
] as const;

export const REPOSITORY_TARGETS: readonly RepositoryTarget[] = [
  {
    linearProjectId: "158874b7-8695-4db0-9199-145f4716c7d6",
    linearProjectName: "AYFORD Finance Monitor",
    repositoryFullName: "allanayford-dev/ayford-finance-monitor",
    baseBranch: "develop",
    validationCommands: [
      { executable: "pnpm", args: ["lint"] },
      { executable: "pnpm", args: ["typecheck"] },
      { executable: "pnpm", args: ["test"] },
      { executable: "pnpm", args: ["build"] },
    ],
    protectedPathPatterns: COMMON_PROTECTED_PATHS,
  },
  {
    linearProjectId: "b3618e27-2082-49b3-bd64-4f5abac00b25",
    linearProjectName: "Portfolio Mini Mobile App",
    repositoryFullName: "allanayford-dev/portfolio-mini-mobile-app",
    baseBranch: "develop",
    validationCommands: [
      { executable: "pnpm", args: ["typecheck"] },
      { executable: "pnpm", args: ["test"] },
    ],
    protectedPathPatterns: COMMON_PROTECTED_PATHS,
  },
] as const;

export function resolveRepositoryTarget(
  project: { id: string; name: string } | null | undefined,
): RepositoryTarget | null {
  if (!project) return null;

  return REPOSITORY_TARGETS.find((target) =>
    target.linearProjectId === project.id ||
    target.linearProjectName === project.name
  ) ?? null;
}
