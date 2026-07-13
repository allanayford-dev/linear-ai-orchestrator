# Automatic Vercel cost reconciliation

The worker exposes a private `POST /internal/reconcile/vercel` operation. It
queries Vercel AI Gateway's Custom Reporting API for the current UTC month,
stores the actual inference cost in `external_costs_monthly`, and immediately
re-evaluates the $18 paid-AI stop and $20 total ceiling. Repeated runs overwrite
the same month total rather than adding it again.

The dashboard shows the last successful sync, covered date range, request count,
and any reporting failure. A failed query keeps the last known actual cost.

## Before scheduling it

Vercel Custom Reporting must be available for the team that owns
`AI_GATEWAY_API_KEY`. The endpoint is available on eligible Pro and Enterprise
plans and is billed per reporting query. Test one live query after deployment
before creating the recurring job.

## Deploy and test

Run these commands from the repository in Cloud Shell after the change is merged:

```bash
git switch develop
git pull --ff-only

gcloud run deploy orchestrator-worker \
  --project=glm-api-server \
  --region=africa-south1 \
  --source=. \
  --service-account=orchestrator-worker@glm-api-server.iam.gserviceaccount.com \
  --no-allow-unauthenticated \
  --concurrency=1 \
  --min-instances=0 \
  --max-instances=1
```

The existing environment variables and Secret Manager bindings should remain on
the service. Verify them after deployment before continuing.

```bash
WORKER_URL="$(gcloud run services describe orchestrator-worker \
  --project=glm-api-server \
  --region=africa-south1 \
  --format='value(status.url)')"

curl --silent --show-error --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "${WORKER_URL}/internal/reconcile/vercel" | jq
```

A successful response contains the month, covered dates, Vercel request count,
and `gatewayActualCostMicros`. Refresh the dashboard and confirm that Vercel
actual cost and sync time now appear. If the response is `502`, inspect the
worker logs. A Vercel `403` normally means Custom Reporting is not enabled for
the API key's team or plan; do not create the schedule until that is resolved.

## Create the private scheduled caller

This creates a least-privilege service account that can invoke only the private
worker. It does not receive Firestore or Secret Manager access.

```bash
PROJECT_ID="glm-api-server"
REGION="africa-south1"
SCHEDULER_SA="vercel-cost-reconciler@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable cloudscheduler.googleapis.com \
  --project="${PROJECT_ID}"

gcloud iam service-accounts describe "${SCHEDULER_SA}" \
  --project="${PROJECT_ID}" >/dev/null 2>&1 || \
gcloud iam service-accounts create vercel-cost-reconciler \
  --project="${PROJECT_ID}" \
  --display-name="Vercel cost reconciler"

gcloud run services add-iam-policy-binding orchestrator-worker \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --member="serviceAccount:${SCHEDULER_SA}" \
  --role="roles/run.invoker"
```

Recommended six-hour schedule (02:15, 08:15, 14:15, and 20:15 Johannesburg
time):

```bash
gcloud scheduler jobs create http vercel-cost-reconciliation \
  --project="${PROJECT_ID}" \
  --location="${REGION}" \
  --schedule="15 2,8,14,20 * * *" \
  --time-zone="Africa/Johannesburg" \
  --uri="${WORKER_URL}/internal/reconcile/vercel" \
  --http-method=POST \
  --oidc-service-account-email="${SCHEDULER_SA}" \
  --oidc-token-audience="${WORKER_URL}" \
  --attempt-deadline=300s
```

To minimize reporting-query charges, use one daily run instead by replacing the
schedule with `15 2 * * *`. The six-hour schedule gives the budget protection a
fresher actual cost. Its reporting-query charge is about $0.60-$0.62 in a
31-day month at Vercel's documented $5 per 1,000 queries; daily is about $0.15.
Keep at least $1 of the $20 ceiling reserved for monitoring and platform costs.

## Verify and operate

Trigger the first scheduled invocation and inspect its result:

```bash
gcloud scheduler jobs run vercel-cost-reconciliation \
  --project="${PROJECT_ID}" \
  --location="${REGION}"

gcloud scheduler jobs describe vercel-cost-reconciliation \
  --project="${PROJECT_ID}" \
  --location="${REGION}" \
  --format='yaml(state,lastAttemptTime,status)'
```

The dashboard is the day-to-day view. Vercel actual cost is compared with the
worker's per-generation estimate; the larger value is used so the same AI calls
are not counted twice. Google Cloud and other platform costs remain separate
manual inputs until their billing exports are automated.
