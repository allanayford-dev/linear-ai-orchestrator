# Linear AI Orchestrator

Three-service Cloud Run platform for receiving signed Linear webhooks, safely
orchestrating Todo issues through Google Cloud Pub/Sub, and monitoring execution
and cost through a Firebase-authenticated operations dashboard.

## Current scope

- `GET /health` liveness endpoint
- `POST /webhooks/linear` signed Linear webhook receiver
- HMAC-SHA256 verification against the exact raw body
- 60-second replay protection window
- Firestore webhook event audit records
- Firestore task records for Linear issue events
- Zero-value task usage records ready for later model-call aggregation
- Pub/Sub publication to `orchestrator-tasks`
- Duplicate delivery protection using `Linear-Delivery`
- Private Pub/Sub push worker with Firestore task leases
- `Todo` -> `In Progress` claims
- Opt-in free-tier routing and simple execution with `gemini-3.1-flash-lite`
- One-time fallback to `zai/glm-4.7-flashx` for Gemini quota/service failures
- Complex execution with `zai/glm-5.2`
- JSON Schema-constrained provider responses for predictable routing and results
- Permanent handoff (without Pub/Sub retry) for malformed model output or rejected requests
- Sensitive-label protection that keeps `ai-sensitive` work away from Gemini
- Human handoff to `Needs My Action`
- Candidate results to `In Review` (never automatically `Done`)
- Per-generation, task, project-month, and model-month usage records
- Per-task token and spending gates plus a per-project spending gate
- Firebase Google sign-in with an explicit dashboard email allowlist
- Task, generation, model, project, alert, and cost dashboard views
- $18 paid-AI safety stop, $20 total ceiling, and 50/75/90/100% alerts
- Manual actual-cost inputs for AI Gateway, Google Cloud, and other providers
- Automatic Vercel AI Gateway actual-cost reconciliation with visible sync health

The first worker produces text-based candidate results. It does not yet clone a
repository, edit code, run tests, or deploy changes; work requiring those tools
is handed to `Needs My Action` instead of being falsely reported as complete.

The liveness route deliberately avoids a path ending in `z`, because Cloud Run
reserves some such paths and can intercept them before they reach the container.

## Data created in Firestore

| Collection | Purpose |
| --- | --- |
| `webhook_events` | Raw event audit, processing status, and Pub/Sub message ID |
| `tasks` | Latest Linear issue snapshot and orchestration identifiers |
| `task_usage` | Per-task token and cost totals, initially zero |
| `generations` | Idempotent ledger entry for every model call and result |
| `project_usage_monthly` | Monthly project token and estimated-cost totals |
| `model_usage_monthly` | Monthly model token and estimated-cost totals |
| `system_usage_monthly` | System-wide model totals used by the circuit breaker |
| `external_costs_monthly` | Actual Gateway, GCP, and other monthly costs |
| `budget_alerts` | Deterministic threshold-crossing alert records |
| `orchestrator_control` | Monthly budget, alert thresholds, and pause state |

Costs use integer micro-dollars. Every provider attempt has its own deterministic
generation ID and is recorded as pending before the model request, then completed
or failed. Billable usage is counted even when a provider call returns malformed
structured output. Gemini free-tier calls still count toward task token limits.

## Worker deployment

The Cloud Shell setup, IAM grants, secrets, private Cloud Run deployment, and
authenticated Pub/Sub push configuration are in
[`docs/deploy-worker.md`](docs/deploy-worker.md). Use `npm run dev:worker` or
`npm run start:worker` for the worker entry point.

Dashboard authentication, deployment, Hosting rewrite, and verification are in
[`docs/deploy-dashboard.md`](docs/deploy-dashboard.md). Use
`npm run dev:dashboard` or `npm run start:dashboard` for its entry point.

Automatic Vercel cost reconciliation and its authenticated Cloud Scheduler job
are documented in
[`docs/deploy-vercel-reconciliation.md`](docs/deploy-vercel-reconciliation.md).

## Local development

Requirements: Node.js 22+ and Google Cloud Application Default Credentials.

```bash
npm install
cp .env.example .env
gcloud auth application-default login
npm run dev
```

Never commit the real Linear webhook secret or a Google service-account key.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `LINEAR_WEBHOOK_SECRET` | Yes | — | Signing secret shown by Linear for the webhook |
| `GCP_PROJECT_ID` | Cloud Run supplies it | ADC project | Google Cloud project ID |
| `PUBSUB_TOPIC` | No | `orchestrator-tasks` | Destination topic |
| `FIRESTORE_DATABASE_ID` | No | `(default)` | Firestore database ID |
| `LINEAR_WEBHOOK_TOLERANCE_MS` | No | `60000` | Replay-protection window |
| `PORT` | No | `8080` | HTTP port supplied by Cloud Run |

Worker-only variables are documented in `.env.worker.example`. Gemini is disabled
unless `GEMINI_ALLOWED_PROJECTS` contains the issue's Linear project name or ID.
An issue carrying any label in `GEMINI_SENSITIVE_LABELS` bypasses Gemini even when
its project is allowed. This is important because free-tier Gemini content may be
handled under different data-use terms from paid providers.

## Verification

```bash
npm test
npm run typecheck
npm run build
docker build -t linear-ai-orchestrator .
```

## Google Cloud prerequisites

Create these resources in project `glm-api-server` before enabling the Linear
webhook:

1. A Firestore Native Mode database.
2. Pub/Sub topic `orchestrator-tasks`.
3. A dedicated Cloud Run runtime service account.
4. Grant that account:
   - `roles/pubsub.publisher` on the topic
   - `roles/datastore.user` for Firestore access
5. Store `LINEAR_WEBHOOK_SECRET` in Secret Manager and grant the runtime account
   `roles/secretmanager.secretAccessor` for that secret.

The service uses Application Default Credentials; no JSON service-account key
belongs in the container.

## Cloud Run deployment

Deploy the first revision as a private smoke test:

- Service name: `linear-webhook`
- Region: `africa-south1`
- Minimum instances: `0`
- Maximum instances: `1`
- CPU allocation: only while processing requests
- Ingress/authentication: require authentication initially
- Container port: `8080`

After the authenticated health check succeeds, Linear must be able to invoke the
webhook. Linear cannot send a Google IAM identity token, so public invocation is
required for this service. At that point:

1. Allow unauthenticated invocation.
2. Keep the signing secret only in Secret Manager.
3. Register `https://SERVICE_URL/webhooks/linear` in Linear.
4. Subscribe initially to Issue events for the `Allanayford` team.
5. Confirm an event produces a `webhook_events` record and Pub/Sub message.

Public invocation does not make unsigned webhook requests valid: the route
rejects requests with an invalid HMAC signature or stale timestamp.

## Delivery behavior

The service writes a received event, publishes it, and then marks it published.
If a process stops after publication but before the final Firestore update,
Pub/Sub can contain a duplicate. Every downstream worker must therefore dedupe
using `deliveryId`.
