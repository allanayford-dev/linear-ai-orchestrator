# Deploy the operations dashboard

The dashboard is a separate public Cloud Run service. Firebase Authentication
protects every data API: the browser signs in with Google, sends its Firebase ID
token, and the server verifies that token plus `DASHBOARD_ALLOWED_EMAILS` before
reading or writing Firestore.

## 1. Enable Firebase Authentication

1. Open Firebase Console and add Firebase to the existing `glm-api-server`
   Google Cloud project.
2. Open **Build > Authentication > Sign-in method**.
3. Enable **Google** and select a support email.
4. Register a Firebase **Web app** named `orchestrator-dashboard`.
5. Copy its `apiKey`, `authDomain`, `appId`, and `messagingSenderId` values.

The web Firebase configuration is an identifier, not a server credential. Do
not create or deploy a service-account JSON key. Cloud Run uses Application
Default Credentials.

## 2. Runtime identity

```bash
gcloud iam service-accounts create orchestrator-dashboard \
  --project=glm-api-server \
  --display-name="Orchestrator dashboard"

gcloud projects add-iam-policy-binding glm-api-server \
  --member="serviceAccount:orchestrator-dashboard@glm-api-server.iam.gserviceaccount.com" \
  --role="roles/datastore.user"
```

## 3. Deploy Cloud Run

Run from the repository root and replace the Firebase web values:

```bash
gcloud run deploy orchestrator-dashboard \
  --project=glm-api-server \
  --region=africa-south1 \
  --source=. \
  --command=node \
  --args=dist/dashboard-server.js \
  --service-account=orchestrator-dashboard@glm-api-server.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --min=0 \
  --max=1 \
  --cpu=1 \
  --memory=512Mi \
  --concurrency=20 \
  --timeout=30 \
  --set-env-vars="GCP_PROJECT_ID=glm-api-server,FIRESTORE_DATABASE_ID=(default),FIREBASE_API_KEY=REPLACE,FIREBASE_AUTH_DOMAIN=glm-api-server.firebaseapp.com,FIREBASE_APP_ID=REPLACE,FIREBASE_MESSAGING_SENDER_ID=847210177848,DASHBOARD_ALLOWED_EMAILS=allan@allanayford.me,MAX_SYSTEM_MONTHLY_COST_MICROS=20000000"
```

Public invocation serves only the login shell and Firebase configuration. Every
task, generation, cost, alert, and control endpoint verifies a Firebase ID token
and the email allowlist.

## 4. Apply the worker's $20 circuit breaker

The worker and dashboard must share the same default limit:

```bash
gcloud run services update orchestrator-worker \
  --project=glm-api-server \
  --region=africa-south1 \
  --update-env-vars="MAX_SYSTEM_MONTHLY_COST_MICROS=20000000,PAID_AI_CIRCUIT_BREAKER_MICROS=18000000"
```

The worker checks `orchestrator_control/global` before each model call. Paid AI
stops at $18, leaving a $2 reserve below the absolute $20 ceiling. It uses
the greater of internal AI estimates and entered AI Gateway actual cost, then
adds Google Cloud and other costs. At the limit it moves work to Needs My Action
and stops making new model calls.

## 5. Optional Firebase Hosting URL

After the Cloud Run service is healthy:

```bash
npx firebase-tools login
npx firebase-tools deploy --only hosting --project glm-api-server
```

`firebase.json` rewrites the Firebase Hosting URL to the Johannesburg Cloud Run
dashboard. Add the resulting `web.app` domain to Firebase Authentication's
authorized domains if it is not already present.

## 6. Verify

```bash
DASHBOARD_URL="$(gcloud run services describe orchestrator-dashboard \
  --project=glm-api-server \
  --region=africa-south1 \
  --format='value(status.url)')"

curl --fail "${DASHBOARD_URL}/health"
```

Then open the URL, sign in with an allowlisted Google account, set actual AI
Gateway cost for the month, and confirm the dashboard displays tasks,
generations, model totals, and the $20 meter.
