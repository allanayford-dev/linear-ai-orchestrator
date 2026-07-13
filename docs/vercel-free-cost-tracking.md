# Vercel cost tracking on the free plan

Vercel's aggregated Custom Reporting endpoint requires an eligible paid team
plan. The orchestrator therefore records spend directly from every successful AI
Gateway response without running a scheduled reporting query.

## How tracking works

1. AI Gateway returns token usage and a USD `usage.cost` with the generation.
2. The worker converts that amount to integer micro-dollars.
3. The generation ledger records the amount with `costSource` set to
   `gateway-response`.
4. The existing Firestore transaction updates the task, Linear project, model,
   and system monthly aggregates exactly once.
5. Budget thresholds and the $18/$20 circuit breakers are evaluated immediately.

If an older provider response omits cost, the worker calculates a conservative
amount from Vercel's public model catalog and records `model-catalog` as the
source. Free Gemini calls record `free-tier` and zero cost.

This is more current than a six-hour job and adds no reporting-query cost. It
only covers requests made through the orchestrator. Use a dedicated AI Gateway
key so unrelated calls cannot bypass its ledger.

## Independent reconciliation

The dashboard's **Vercel CSV reconciliation** field remains available. Export a
Vercel usage CSV weekly or at month-end, enter its total, and save. The dashboard
uses the greater of:

* the orchestrator's per-request cost total; or
* the independently entered Vercel CSV total.

This avoids double-counting while allowing the external total to catch calls
made outside the worker.

## Hard Vercel key limit

In Vercel, open **AI Gateway > API Keys**, edit the dedicated
`linear-orchestrator` key, and configure:

* Spend quota: `$10`
* Refresh period: `Monthly`
* Automatic top-up: disabled

The Vercel key cap is the outer guardrail. Firestore's $18 paid-AI stop and $20
system ceiling remain the orchestrator-wide controls that also account for
manually entered Google Cloud and other costs.

## Deploy and verify

After merging the change, deploy the worker and dashboard from `develop`. Then
move one low-risk test issue to `Todo` and confirm its generation record contains:

* `costSource: gateway-response` for a paid Vercel call;
* a non-negative `estimatedCostMicros` matching the response cost;
* updated task, project, model, and system monthly aggregates.

No Cloud Scheduler job should be created for Vercel reporting on the free plan.
