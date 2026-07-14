# Deploy `orchestrator-worker`

These commands target project `glm-api-server` and region `africa-south1`.
Run them in Google Cloud Shell after the `develop` branch is pushed.

## 1. Create secrets without putting values in shell history

Create a Linear personal API key with permission to read issues, update issues,
and create comments. Create a Vercel AI Gateway API key and apply a hard provider
spend limit that fits inside the overall $20 monthly budget (recommended: $10).
Create a Gemini API key in Google AI Studio for free-tier eligible work.

```bash
read -s -p "Linear API key: " LINEAR_API_KEY; echo
printf %s "$LINEAR_API_KEY" | gcloud secrets create linear-api-key \
  --project=glm-api-server --replication-policy=automatic --data-file=-
unset LINEAR_API_KEY

read -s -p "AI Gateway API key: " AI_GATEWAY_API_KEY; echo
printf %s "$AI_GATEWAY_API_KEY" | gcloud secrets create ai-gateway-api-key \
  --project=glm-api-server --replication-policy=automatic --data-file=-
unset AI_GATEWAY_API_KEY

read -s -p "Gemini API key: " GEMINI_API_KEY; echo
printf %s "$GEMINI_API_KEY" | gcloud secrets create gemini-api-key \
  --project=glm-api-server --replication-policy=automatic --data-file=-
unset GEMINI_API_KEY
```

If a secret already exists, use `gcloud secrets versions add SECRET_NAME
--data-file=-` instead of `secrets create`.

## 2. Create least-privilege identities

```bash
PROJECT=glm-api-server
REGION=africa-south1
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')

gcloud iam service-accounts create orchestrator-worker \
  --project="$PROJECT" --display-name="Linear orchestrator worker"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:orchestrator-worker@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/datastore.user

for SECRET in linear-api-key ai-gateway-api-key gemini-api-key; do
  gcloud secrets add-iam-policy-binding "$SECRET" --project="$PROJECT" \
    --member="serviceAccount:orchestrator-worker@$PROJECT.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
done

gcloud iam service-accounts create pubsub-push \
  --project="$PROJECT" --display-name="Authenticated Pub/Sub push"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role=roles/iam.serviceAccountTokenCreator
```

## 3. Deploy the private worker

```bash
git clone https://github.com/allanayford-dev/linear-ai-orchestrator.git
cd linear-ai-orchestrator
git checkout develop

gcloud run deploy orchestrator-worker \
  --project="$PROJECT" \
  --region="$REGION" \
  --source=. \
  --service-account="orchestrator-worker@$PROJECT.iam.gserviceaccount.com" \
  --no-allow-unauthenticated \
  --ingress=all \
  --min=0 \
  --max=1 \
  --concurrency=1 \
  --cpu=1 \
  --cpu-throttling \
  --no-cpu-boost \
  --memory=512Mi \
  --timeout=600 \
  --command=node \
  --args=dist/worker-server.js \
  --set-env-vars="GCP_PROJECT_ID=$PROJECT,FIRESTORE_DATABASE_ID=(default),GEMINI_MODEL=gemini-3.1-flash-lite,GEMINI_ALLOWED_PROJECTS=YOUR_LINEAR_PROJECT_NAME_OR_ID,GEMINI_SENSITIVE_LABELS=ai-sensitive,ROUTER_MODEL=zai/glm-4.7-flashx,EXECUTOR_MODEL=zai/glm-5.2,LINEAR_TODO_STATE=Todo,LINEAR_IN_PROGRESS_STATE=In Progress,LINEAR_NEEDS_ACTION_STATE=Needs My Action,LINEAR_REVIEW_STATE=In Review,TASK_LEASE_SECONDS=900,MAX_DELIVERY_ATTEMPTS=5,MAX_TASK_COST_MICROS=250000,MAX_TASK_TOKENS=50000,MAX_PROJECT_MONTHLY_COST_MICROS=5000000" \
  --set-secrets="LINEAR_API_KEY=linear-api-key:latest,AI_GATEWAY_API_KEY=ai-gateway-api-key:latest,GEMINI_API_KEY=gemini-api-key:latest"
```

Replace `YOUR_LINEAR_PROJECT_NAME_OR_ID` with an explicitly approved Linear
project. An empty allowlist disables Gemini. Add the `ai-sensitive` label to any
issue that must bypass the free tier; the paid GLM route remains available.

`max=1` and `concurrency=1` intentionally serialize the pilot. This controls
spend and makes the initial lease behavior easy to audit. Request-based billing
and `min=0` keep idle Cloud Run compute at zero.

## 4. Verify before connecting the queue

```bash
WORKER_URL=$(gcloud run services describe orchestrator-worker \
  --project="$PROJECT" --region="$REGION" --format='value(status.url)')

curl -i -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "$WORKER_URL/health"
```

Expected: HTTP 200 and `{"status":"ok","service":"orchestrator-worker"}`.

## 5. Connect authenticated Pub/Sub push

First discard the old pilot backlog so enabling push does not unexpectedly
process historical Todo events. Events created after this seek are retained.

```bash
gcloud pubsub subscriptions seek orchestrator-worker \
  --project="$PROJECT" --time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

gcloud pubsub subscriptions update orchestrator-worker \
  --project="$PROJECT" --ack-deadline=600 \
  --min-retry-delay=10s --max-retry-delay=600s

gcloud run services add-iam-policy-binding orchestrator-worker \
  --project="$PROJECT" --region="$REGION" \
  --member="serviceAccount:pubsub-push@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/run.invoker

gcloud pubsub subscriptions modify-push-config orchestrator-worker \
  --project="$PROJECT" \
  --push-endpoint="$WORKER_URL/pubsub/push" \
  --push-auth-service-account="pubsub-push@$PROJECT.iam.gserviceaccount.com" \
  --push-auth-token-audience="$WORKER_URL"
```

Cloud Run validates the Google-signed identity token before the request reaches
the application. A 2xx response acknowledges the message; transient worker
failures return 500 and are retried by Pub/Sub.

## 6. Add exhausted-delivery handling

Pub/Sub dead-letter forwarding is best-effort. Five is the platform's minimum
configured delivery-attempt count. The Pub/Sub service agent must be allowed to
publish to the dead-letter topic and acknowledge the source subscription or
attempt counting and forwarding will not operate correctly.

```bash
PUBSUB_SERVICE_AGENT="service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com"

gcloud pubsub topics describe orchestrator-dead-letter \
  --project="$PROJECT" >/dev/null 2>&1 || \
gcloud pubsub topics create orchestrator-dead-letter --project="$PROJECT"

gcloud pubsub topics add-iam-policy-binding orchestrator-dead-letter \
  --project="$PROJECT" \
  --member="serviceAccount:$PUBSUB_SERVICE_AGENT" \
  --role=roles/pubsub.publisher

gcloud pubsub subscriptions add-iam-policy-binding orchestrator-worker \
  --project="$PROJECT" \
  --member="serviceAccount:$PUBSUB_SERVICE_AGENT" \
  --role=roles/pubsub.subscriber

gcloud pubsub subscriptions describe orchestrator-dead-letter-monitor \
  --project="$PROJECT" >/dev/null 2>&1 || \
gcloud pubsub subscriptions create orchestrator-dead-letter-monitor \
  --project="$PROJECT" \
  --topic=orchestrator-dead-letter \
  --push-endpoint="$WORKER_URL/pubsub/dead-letter" \
  --push-auth-service-account="pubsub-push@$PROJECT.iam.gserviceaccount.com" \
  --push-auth-token-audience="$WORKER_URL" \
  --ack-deadline=60 \
  --min-retry-delay=10s \
  --max-retry-delay=600s \
  --message-retention-duration=7d \
  --expiration-period=never

gcloud pubsub subscriptions update orchestrator-worker \
  --project="$PROJECT" \
  --dead-letter-topic=orchestrator-dead-letter \
  --max-delivery-attempts=5
```

Verify the source policy and authenticated dead-letter push endpoint:

```bash
gcloud pubsub subscriptions describe orchestrator-worker \
  --project="$PROJECT" \
  --format='yaml(deadLetterPolicy,retryPolicy,pushConfig)'

gcloud pubsub subscriptions describe orchestrator-dead-letter-monitor \
  --project="$PROJECT" \
  --format='yaml(topic,pushConfig,retryPolicy)'
```

For a non-destructive smoke test, publish a diagnostic message directly to the
dead-letter topic. This tests storage and dashboard visibility without forcing a
real task to fail five times.

```bash
gcloud pubsub topics publish orchestrator-dead-letter \
  --project="$PROJECT" \
  --message='{"deliveryId":"dead-letter-smoke-test","source":"manual-test","receivedAt":"2026-07-13T00:00:00.000Z","payload":{"data":{"identifier":"DLQ-SMOKE"}}}' \
  --attribute=CloudPubSubDeadLetterSourceSubscription=projects/$PROJECT/subscriptions/orchestrator-worker,CloudPubSubDeadLetterSourceSubscriptionProject=$PROJECT,CloudPubSubDeadLetterSourceDeliveryCount=5
```

Open **Task execution** in the dashboard and confirm `DLQ-SMOKE` appears under
**Exhausted deliveries**. Repeating the same Pub/Sub delivery is idempotent.
Malformed deliveries are retained with diagnostic errors and acknowledged so
the dead-letter subscription itself cannot loop forever.

Do not automatically replay dead letters. Diagnose and fix the underlying
problem, then republish only the original work event that is safe to retry.

### Lease recovery and application delivery limit

The worker also enforces `MAX_DELIVERY_ATTEMPTS=5` before any model call. A
delivery at the limit is recorded as `delivery_limit_reached` and returns a
retryable response so Pub/Sub can forward it to the dead-letter topic. A
completed delivery is still acknowledged as a duplicate before this check.

Firestore task leases prevent a different delivery from processing the same
issue while the lease is active. When the lease expires, the next delivery can
reclaim the task even if Linear already shows **In Progress**. Recovery records
`recoveryCount`, `previousDeliveryId`, `recoveredAt`, the new delivery attempt,
message ID, and subscription. The dashboard's task ledger shows both attempt
and recovery counts.

To inspect recovered or delivery-limited tasks:

```bash
ACCESS_TOKEN="$(gcloud auth print-access-token)"

curl --silent --show-error \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://firestore.googleapis.com/v1/projects/$PROJECT/databases/%28default%29/documents/tasks?pageSize=100" | \
jq '[.documents[]? | {
  issue: (.fields.issueIdentifier.stringValue // ""),
  status: (.fields.orchestrationStatus.stringValue // ""),
  deliveryAttempt: ((.fields.deliveryAttempt.integerValue // "0") | tonumber),
  recoveryCount: ((.fields.recoveryCount.integerValue // "0") | tonumber),
  previousDeliveryId: (.fields.previousDeliveryId.stringValue // "")
}] | map(select(.recoveryCount > 0 or .status == "delivery_limit_reached"))'

unset ACCESS_TOKEN
```

## 7. Pilot safely

Create one inexpensive Linear issue in `Todo` with a complete description. It
should move through `In Progress` and end in either:

- `In Review`, with a candidate result and usage summary; or
- `Needs My Action`, with a concrete reason and next action.

Confirm Firestore contains records in `generations`, `task_usage`,
`project_usage_monthly`, and `model_usage_monthly`. Do not bulk-enable old Todo
issues until the pilot record and the Vercel spend limit have been checked.

For an eligible simple issue, the Linear usage comment should name
`google-gemini/gemini-3.1-flash-lite (free)` and Vercel spend should remain
unchanged. A Gemini `429` or temporary `5xx` is recorded as a failed attempt and
receives exactly one GLM FlashX fallback.
