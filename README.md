# Linear AI Orchestrator

Two-service Cloud Run starter for receiving signed Linear webhooks and safely
orchestrating Todo issues through Google Cloud Pub/Sub.

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
- Low-cost routing with `zai/glm-4.7-flashx`
- Complex execution with `zai/glm-5.2`
- Human handoff to `Needs My Action`
- Candidate results to `In Review` (never automatically `Done`)
- Per-generation, task, project-month, and model-month usage records
- Per-task and per-project internal AI spending gates

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

Costs use integer micro-dollars. A generation is recorded as pending before the
model request and then completed or failed, making retries auditable.

## Worker deployment

The Cloud Shell setup, IAM grants, secrets, private Cloud Run deployment, and
authenticated Pub/Sub push configuration are in
[`docs/deploy-worker.md`](docs/deploy-worker.md). Use `npm run dev:worker` or
`npm run start:worker` for the worker entry point.

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
