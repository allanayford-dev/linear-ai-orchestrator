# Repository executor contract and security model

This document defines the boundary between the Linear AI Orchestrator and the future repository executor. The worker may route and prepare repository work only for explicitly mapped Linear projects. Unknown projects fail closed and must be handed to a human.

## Project-to-repository mapping

| Linear project | Linear project ID | GitHub repository | Base branch |
| --- | --- | --- | --- |
| AYFORD Finance Monitor | `158874b7-8695-4db0-9199-145f4716c7d6` | `allanayford-dev/ayford-finance-monitor` | `develop` |
| Portfolio Mini Mobile App | `b3618e27-2082-49b3-bd64-4f5abac00b25` | `allanayford-dev/portfolio-mini-mobile-app` | `develop` |

The canonical mapping lives in `src/services/repository-target-policy.ts`. Resolution uses the Linear project ID first and the exact project name only as a controlled fallback. No repository may be inferred from an issue title, branch name, URL, or model output.

## Validation commands

Commands are represented as executable plus argument arrays. The executor must not accept arbitrary shell strings from models or Linear issue text.

### AYFORD Finance Monitor

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build`

### Portfolio Mini Mobile App

1. `pnpm typecheck`
2. `pnpm test`

A repository-specific executor may add a stricter validation step, but it may not skip the mapped baseline without human approval.

## Protected paths

The executor must reject automatic writes to these paths and patterns:

- `.env`
- `.env.*`
- `**/*.pem`
- `**/*.key`
- `**/*service-account*.json`
- `.github/workflows/**`
- `.github/CODEOWNERS`

A task requiring one of these paths is moved to `Needs My Action` with the proposed change described in the handoff. Secrets must never be written to a repository, model prompt, task comment, test artifact, or executor log.

## GitHub permissions

Use a GitHub App or equivalent installation token scoped only to explicitly mapped repositories. Minimum repository permissions for the implementation phase are:

- Contents: read and write
- Pull requests: read and write
- Metadata: read

Do not grant repository administration, secrets, environments, actions administration, or organization administration. Workflow-file modification remains prohibited even if the installation token could technically write it.

## Execution limits

Each execution request must carry explicit limits. Initial defaults for the sandboxed executor are:

- Maximum wall-clock duration: 15 minutes
- Maximum changed files: 40
- Maximum generated diff: 1 MiB
- Existing orchestrator task token cap: 50,000 tokens
- Existing task cost cap: 250,000 micro-dollars
- Existing project monthly cost cap: 5,000,000 micro-dollars
- Existing system paid-AI stop and total monthly ceiling remain authoritative

The executor must stop safely when a limit is reached and preserve diagnostic evidence without opening a misleading ready-for-review pull request.

## Branch and pull-request rules

- Start from the mapped `develop` branch.
- Create one task branch per Linear issue.
- Never push directly to `develop` or `main`.
- Never force-push a protected base branch.
- Never merge a pull request automatically.
- A successful implementation ends in `In Review`, not `Done`.
- Human review and merge remain mandatory.

## Human approval conditions

Move the issue to `Needs My Action` instead of continuing automatically when:

- the Linear project is not mapped;
- the task requests a protected path;
- credentials, secrets, signing keys, production data, or identity-provider configuration are required;
- repository permissions are insufficient;
- the requested action would modify CI/CD or deployment permissions;
- validation cannot be run deterministically;
- the executor reaches a configured time, token, cost, file-count, or diff-size limit;
- the model requests destructive Git operations, direct base-branch writes, or automatic merge;
- requirements are materially ambiguous and implementation would require guessing.

## Executor request and result

Typed request and result contracts are defined in `src/types/repository-executor.ts`.

The request identifies the Linear task and mapped repository target, provides a deterministic task branch, supplies only structured validation commands, and carries execution limits.

The result records the repository, branch, optional commit and pull request, changed files, validation evidence, summary, and handoff reason. Valid outcomes are:

- `ready_for_review`
- `needs_action`
- `validation_failed`
- `rejected`

No executor result may directly mark a Linear issue `Done`.

## Next implementation phase

`ALL-242` builds the sandboxed repository executor that consumes this contract. Until that phase is deployed, the current worker remains a text-result orchestrator and repository-changing tasks continue to require human action.
