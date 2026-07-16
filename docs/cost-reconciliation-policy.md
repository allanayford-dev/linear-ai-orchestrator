# Cost reconciliation policy

This document defines the canonical monthly cost model for the Linear AI Orchestrator.

## Canonical currency

The Orchestrator budget currency is **USD**. Every amount included in task, project, model, provider, or system budget calculations must be represented as integer **USD micro-dollars** before aggregation.

Source systems may report another currency, but unlike currencies must never be added together.

For audit, a normalized cost record should preserve:

- original source amount;
- original source currency;
- normalized USD micro-dollar amount;
- conversion rate and conversion timestamp when conversion is required;
- conversion source or method.

Until an approved FX-normalization implementation exists, automated Google Cloud reconciliation fails closed when the billing export currency is not USD. The failed reconciliation is audited and the last valid normalized total remains authoritative. This prevents a non-USD amount from being silently treated as USD.

## Cost sources and precedence

### Firestore model ledger

The generation ledger is the operational source for model usage created by the Orchestrator. Successful paid AI Gateway calls use the provider response cost where available. A model-catalog estimate is a fallback when the provider response omits cost. Free-tier calls remain zero monetary cost but still count toward token limits.

### Vercel AI Gateway

The internal per-request total is updated immediately from Orchestrator calls. The manually entered Vercel CSV value is an independent reconciliation source.

For budget protection, the authoritative Vercel amount is the greater of:

1. the internal per-request paid-AI total; or
2. the external Vercel CSV total.

This is intentionally conservative and avoids double-counting while preventing an understated internal ledger from weakening the circuit breaker.

### Google Cloud

The Standard Cloud Billing Export in BigQuery is the authoritative external source for Google Cloud infrastructure cost. Reconciliation refreshes every six hours. Dashboard data older than 12 hours is considered stale.

A successful reconciliation replaces the current month's Google Cloud external cost with the latest authoritative normalized monthly export total and creates an immutable reconciliation audit record.

A failed reconciliation must not overwrite the last valid total.

## Refresh intervals

- Firestore generation and aggregate usage: immediately after each recorded generation.
- Vercel per-request paid-AI cost: immediately after each successful Gateway response.
- Vercel CSV reconciliation: weekly or at month-end, and whenever an unexplained variance is suspected.
- Google Cloud billing export reconciliation: every six hours.
- Google Cloud stale threshold: 12 hours since the last successful reconciliation.

## Reconciliation variance and tolerance

Where both an internal total and an external source total exist, calculate:

`variance = absolute(external total - internal total)`

Investigate the variance when it exceeds the greater of:

- **USD 0.25**; or
- **5% of the external source total**.

The tolerance is an investigation threshold, not a budget discount. A variance below tolerance does not reduce or delay budget protection.

For guardrails, use the most conservative valid total available according to the source precedence rules.

## Budget controls

The existing system controls remain authoritative:

- paid-AI safety stop: USD 18;
- total monthly ceiling: USD 20;
- deterministic alert thresholds: 50%, 75%, 90%, and 100%.

Cost reconciliation may pause paid AI or the whole Orchestrator when a newly reconciled authoritative cost crosses a configured threshold.

## Failure behaviour

The system must fail closed when:

- a cost source cannot be normalized to USD;
- a required source currency is unknown;
- a conversion record lacks required audit evidence;
- a reconciliation query fails;
- returned aggregate values are invalid.

Failure records remain auditable. The previous valid total remains available and must not be silently replaced with zero or an incompatible currency.

## Source-of-truth summary

| Cost area | Operational source | External reconciliation source | Budget rule |
| --- | --- | --- | --- |
| AI model usage | Firestore generation ledger | Provider response / Vercel CSV | Use conservative valid USD total |
| Vercel paid AI | Per-request Gateway response cost | Manual Vercel CSV | Use greater of internal and CSV total |
| Google Cloud | Reconciled monthly external cost | BigQuery Standard Billing Export | Latest valid normalized monthly total |
| Other external cost | Audited manual external-cost entry | Supporting invoice or source record | USD micro-dollars only |

All budget calculations are performed only after costs are represented in canonical USD micro-dollars.
