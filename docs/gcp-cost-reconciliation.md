# Google Cloud cost reconciliation

The worker reads the Standard Cloud Billing export in BigQuery, totals the selected project's net cost for a calendar month, and writes that value to `external_costs_monthly/{month}`. The dashboard reports the last successful update and flags data older than 12 hours as stale.

## 1. Confirm the export table

The Standard usage cost export is enabled for the EU multi-region dataset `glm-api-server.billing_export_eu`. Google can take several hours to create and initially populate its table. Find the exact table name after it appears:

```sh
bq ls --project_id=glm-api-server billing_export_eu
```

For billing account `015AA7-5DF422-969C4D`, the expected table is:

```text
glm-api-server.billing_export_eu.gcp_billing_export_v1_015AA7_5DF422_969C4D
```

## 2. Grant the worker read-only billing access

```sh
PROJECT=glm-api-server
DATASET=billing_export_eu
WORKER_SA=orchestrator-worker@${PROJECT}.iam.gserviceaccount.com

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${WORKER_SA}" \
  --role="roles/bigquery.jobUser"

bq query \
  --project_id="$PROJECT" \
  --location=EU \
  --use_legacy_sql=false \
  "GRANT \`roles/bigquery.dataViewer\` ON SCHEMA \`${PROJECT}\`.${DATASET} TO \"serviceAccount:${WORKER_SA}\""
```

The worker needs permission to create query jobs and read only this dataset. It does not need Billing Account Administrator access.

## 3. Deploy the worker configuration

After merging the implementation and updating the repository in Cloud Shell:

```sh
gcloud run services update orchestrator-worker \
  --project=glm-api-server \
  --region=africa-south1 \
  --update-env-vars="^:^GCP_BILLING_TABLE=glm-api-server.billing_export_eu.gcp_billing_export_v1_015AA7_5DF422_969C4D:GCP_BILLING_LOCATION=EU:GCP_BILLING_PROJECT_FILTER=glm-api-server:GCP_BILLING_MAX_BYTES_BILLED=100000000"
```

The 100 MB maximum-bytes-billed setting makes the query fail safely instead of scanning more data than expected. The query is also restricted to the requested usage month, billing table partition, and project ID.

## 4. Run one reconciliation

```sh
WORKER_URL="$(gcloud run services describe orchestrator-worker \
  --project=glm-api-server \
  --region=africa-south1 \
  --format='value(status.url)')"

curl --silent --show-error --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "${WORKER_URL}/internal/reconcile/gcp" | jq
```

If the export table is not populated yet, this returns a controlled error and records a failed reconciliation without overwriting the last valid cost.

## 5. Schedule every six hours

```sh
PROJECT=glm-api-server
RUN_REGION=africa-south1
# Cloud Scheduler is not offered in africa-south1. europe-west1 is a supported
# scheduler control-plane location; it can invoke the Johannesburg HTTPS URL.
SCHEDULER_REGION=europe-west1
SCHEDULER_SA="orchestrator-scheduler@${PROJECT}.iam.gserviceaccount.com"

gcloud services enable cloudscheduler.googleapis.com \
  --project="$PROJECT"

gcloud iam service-accounts describe "$SCHEDULER_SA" \
  --project="$PROJECT" >/dev/null 2>&1 || \
gcloud iam service-accounts create orchestrator-scheduler \
  --project="$PROJECT" \
  --display-name="Orchestrator scheduler"

gcloud run services add-iam-policy-binding orchestrator-worker \
  --project="$PROJECT" \
  --region="$RUN_REGION" \
  --member="serviceAccount:${SCHEDULER_SA}" \
  --role="roles/run.invoker"

WORKER_URL="$(gcloud run services describe orchestrator-worker \
  --project="$PROJECT" \
  --region="$RUN_REGION" \
  --format='value(status.url)')"

gcloud scheduler jobs create http gcp-cost-reconcile-6h \
  --project="$PROJECT" \
  --location="$SCHEDULER_REGION" \
  --schedule="0 */6 * * *" \
  --time-zone="Etc/UTC" \
  --uri="${WORKER_URL}/internal/reconcile/gcp" \
  --http-method=POST \
  --oidc-service-account-email="$SCHEDULER_SA" \
  --oidc-token-audience="$WORKER_URL" \
  --attempt-deadline=300s
```

If `gcp-cost-reconcile-6h` already exists, use `gcloud scheduler jobs update http` with the same options. Run it immediately to verify the identity and endpoint:

```sh
gcloud scheduler jobs run gcp-cost-reconcile-6h \
  --project=glm-api-server \
  --location=europe-west1
```

## 6. Verify Firestore and the dashboard

Successful runs create immutable records in `cost_reconciliations` and update:

- `external_costs_monthly/{YYYY-MM}.gcpCostMicros`
- `external_costs_monthly/{YYYY-MM}.gcpCostUpdatedAt`
- `external_costs_monthly/{YYYY-MM}.gcpCostStatus`

Refresh **Costs & models**. Google Cloud should show `fresh`, the BigQuery source, and the last reconciliation time. Manual dashboard changes are also audited and are labelled `manual`.

## Canonical currency requirement

The Orchestrator budget currency is USD and all budget calculations use integer USD micro-dollars. Google Cloud billing values must therefore be normalized to USD before they can be aggregated with AI or other platform costs.

The current automated Google Cloud reconciliation accepts only a billing export whose reported currency is `USD`. If the export reports another currency, reconciliation fails closed, records the failure, and preserves the last valid monthly cost instead of treating the foreign-currency amount as USD.

An approved future FX-normalization implementation must preserve the original source amount and currency together with the USD amount, conversion rate, conversion timestamp, and conversion source for audit.

See `docs/cost-reconciliation-policy.md` for source precedence, refresh intervals, currency handling, and reconciliation tolerance.

## Rollback

Pause the schedule without deleting its history:

```sh
gcloud scheduler jobs pause gcp-cost-reconcile-6h \
  --project=glm-api-server \
  --location=europe-west1
```

Then route the worker back to its preceding healthy revision in Cloud Run. The last valid Google Cloud total remains available in Firestore. If an urgent correction is needed, use **Budget controls → Actual external costs**; the dashboard records the previous and replacement Google Cloud values in `cost_reconciliations` and labels the source `manual`.
