# Cost safety, pause, and recovery

This document describes the operational controls for the Linear AI Orchestrator cost monitor.

## Safety flow

```text
[START]
   |
   v
[Linear webhook received]
   |
   v
[Validate and synchronize latest Linear state]
   |
   v
<Global manual pause enabled?>
   | No                              | Yes
   v                                 v
[Allow new Todo claim]          [Do not claim new task]
   |                            [Webhook intake remains available]
   v                                 |
[Choose model pricing tier]          v
   |                               [END]
   v
<Paid model call?>
   | No                              | Yes
   v                                 v
[Check system/task/token limits]  <Monthly total >= $18 paid stop?>
   |                                 | No                | Yes
   |                                 v                   v
   |                           [Allow paid call]    [Block paid call]
   |                                 |             [Needs My Action]
   +----------------------+----------+                   |
                          |                              v
                          v                            [END]
                 [Record usage and cost]
                          |
                          v
                 <Crossed $10/$15/$18 alert?>
                    | No             | Yes
                    v                v
                 [Continue]     [Persist budget alert]
                    |                |
                    +-------+--------+
                            |
                            v
                 <Monthly total >= $20?>
                    | No             | Yes
                    v                v
                 [Continue]     [Pause all model execution]
                    |                |
                    v                v
                  [END]            [END]
```

## Alert points

The default monthly target is **USD 20**. The default percentage thresholds map to these operational alert points:

- 50% = **USD 10**
- 75% = **USD 15**
- 90% = **USD 18**
- 100% = **USD 20**

Crossed thresholds are persisted in the `budget_alerts` collection and surfaced in the operations dashboard. The USD 18 point is also the default paid-AI circuit breaker.

The threshold-crossing policy is tested against the exact USD 10, USD 15, and USD 18 boundaries for the default USD 20 target.

## Paid-AI circuit breaker

Before every model generation the worker checks task, project, token, system, and paid-AI limits.

When the current monthly total is at or above **USD 18**, new calls whose pricing tier is `paid` are rejected with `BudgetExceededError`. Eligible free-tier model work may continue until another configured limit or the total monthly ceiling stops it.

A paid call that causes the total to cross the threshold is recorded. Subsequent paid calls are blocked.

The **USD 20** total monthly ceiling remains the system-wide stop.

## Manual pause

The dashboard control `Pause new executions` controls the global `orchestrator_control/global.paused` flag.

When this flag is enabled:

1. Linear webhook intake continues.
2. The latest Linear state is still synchronized.
3. New Todo tasks are not claimed.
4. No new model call begins for those unclaimed tasks.
5. Existing In Progress delivery recovery is not automatically discarded; it follows the normal delivery recovery path.

This keeps the control plane observable while preventing new task execution.

## Audit evidence

Manual budget-control changes are written to `orchestrator_control_audit`.

Each audit record contains:

- action: `pause`, `resume`, or `settings_update`;
- actor email;
- previous global pause state;
- previous paid-AI pause state;
- requested pause state;
- previous and requested monthly budget;
- previous and requested paid-AI circuit-breaker amount;
- previous and requested alert thresholds;
- pause reason when supplied;
- pending, complete, or error status;
- timestamps and error evidence when applicable.

The current control document remains the operational state. The audit collection is the historical evidence of manual overrides and recovery actions.

## Recovery procedure

### Resume after a manual global pause

1. Open the Orchestrator dashboard.
2. Review the current month total, remaining budget, Google Cloud freshness, and recent model usage.
3. Confirm that resuming execution is appropriate.
4. Clear `Pause new executions`.
5. Save the protection settings.
6. Confirm the dashboard reports execution as active.
7. Move only the tasks that should run back to Todo when a retry is required.

The control change is recorded in `orchestrator_control_audit`.

### Recover paid AI after the USD 18 stop

Do not raise or clear the paid-AI stop merely to bypass the safety threshold.

1. Reconcile Vercel, Firestore, and Google Cloud costs.
2. Confirm the selected reporting month and cost freshness.
3. At a new month, confirm the new month's total is below the configured paid-AI threshold.
4. Use the dashboard protection settings to perform an audited resume action when the persisted paid-AI pause state needs to be cleared.
5. The worker still recalculates the current month's total before every paid call. If the total remains at or above the configured paid limit, paid calls remain blocked even after a manual resume.

### Override a configured limit

A limit change is a deliberate administrative override.

1. Verify the authoritative cost sources.
2. Record the business reason in the pause/recovery context where available.
3. Change only the required budget or circuit-breaker setting.
4. Save the settings.
5. Confirm an `orchestrator_control_audit` record exists for the actor and change.
6. Monitor the next model call and budget alert state.

## What a pause does not do

A pause does not disable the public Linear webhook receiver, delete queued events, erase task history, merge pull requests, or deploy production. It only prevents new task execution according to the control described above.
