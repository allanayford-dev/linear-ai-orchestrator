import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";

type RecordValue = Record<string, unknown>;
interface DashboardData {
  month: string;
  paidAiCircuitBreakerMicros: number;
  paidAiPaused: boolean;
  budget: {
    estimatedAiCostMicros: number;
    gatewayActualCostMicros: number;
    gcpCostMicros: number;
    otherCostMicros: number;
    effectiveAiCostMicros: number;
    totalCostMicros: number;
    budgetMicros: number;
    percentageUsed: number;
    remainingMicros: number;
    paused: boolean;
  };
  thresholds: number[];
  tasks: RecordValue[];
  generations: RecordValue[];
  projects: RecordValue[];
  models: RecordValue[];
  alerts: RecordValue[];
  deadLetters: RecordValue[];
  gcpCostFreshness: {
    status: "fresh" | "stale" | "pending" | "manual" | "error";
    source: string;
    updatedAt: string | null;
    error: string | null;
  };
}

const byId = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const login = byId<HTMLDivElement>("login");
const appShell = byId<HTMLDivElement>("app");
const monthInput = byId<HTMLInputElement>("month");
const message = byId<HTMLDivElement>("message");
let currentUser: User | null = null;
let dashboard: DashboardData | null = null;

const dollars = (micros: number, precision = 2) =>
  (micros / 1_000_000).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
const integer = (value: unknown) => Number(value ?? 0).toLocaleString();
const text = (value: unknown) => String(value ?? "—");
const html = (value: unknown) => text(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const statusClass = (value: unknown) => text(value).toLowerCase().replaceAll(" ", "-");
const timestamp = (value: unknown) => {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

function showMessage(copy: string, isError = false) {
  message.textContent = copy;
  message.style.color = isError ? "var(--red)" : "#cfe0ff";
  message.classList.remove("hidden");
  window.setTimeout(() => message.classList.add("hidden"), 4500);
}

async function api(path: string, options: RequestInit = {}) {
  if (!currentUser) throw new Error("Sign in required");
  const token = await currentUser.getIdToken();
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? "Request failed");
  }
  return response.status === 204 ? null : response.json();
}

function taskTable(tasks: RecordValue[], limit?: number) {
  const rows = typeof limit === "number" ? tasks.slice(0, limit) : tasks;
  if (!rows.length) return '<div class="empty">No task executions recorded yet.</div>';
  return `<table><thead><tr><th>Issue</th><th>Task</th><th>Status</th><th>Delivery</th><th>Updated</th></tr></thead><tbody>${rows.map((task) => `
    <tr>
      <td>${html(task.issueIdentifier)}</td>
      <td>${html(task.title)}</td>
      <td><span class="chip ${statusClass(task.orchestrationStatus)}">${html(task.orchestrationStatus)}</span></td>
      <td>attempt ${integer(task.deliveryAttempt || 1)}${Number(task.recoveryCount ?? 0) > 0 ? ` · recovered ${integer(task.recoveryCount)}` : ""}</td>
      <td>${html(timestamp(task.updatedAt))}</td>
    </tr>`).join("")}</tbody></table>`;
}

function generationTable(generations: RecordValue[]) {
  if (!generations.length) return '<div class="empty">No model generations recorded yet.</div>';
  return `<table><thead><tr><th>Issue</th><th>Role</th><th>Provider / model</th><th>Status</th><th>Tokens</th><th>Cost</th><th>Cost source</th><th>Updated</th></tr></thead><tbody>${generations.map((item) => `
    <tr>
      <td>${html(item.issueIdentifier)}</td>
      <td>${html(item.role)}</td>
      <td>${html(item.provider)} / ${html(item.model)}</td>
      <td><span class="chip ${statusClass(item.status)}">${html(item.status)}</span></td>
      <td>${integer(item.totalTokens)}</td>
      <td>${dollars(Number(item.estimatedCostMicros ?? 0), 6)}</td>
      <td>${html(item.costSource ?? "legacy estimate")}</td>
      <td>${html(timestamp(item.updatedAt))}</td>
    </tr>`).join("")}</tbody></table>`;
}

function deadLetterTable(deadLetters: RecordValue[]) {
  if (!deadLetters.length) return '<div class="empty">No exhausted deliveries recorded.</div>';
  return `<table><thead><tr><th>Issue</th><th>Source subscription</th><th>Attempts</th><th>State</th><th>Received</th></tr></thead><tbody>${deadLetters.map((item) => `
    <tr>
      <td>${html(item.issueIdentifier)}</td>
      <td>${html(item.sourceSubscription)}</td>
      <td>${integer(item.sourceDeliveryCount)}</td>
      <td><span class="chip ${statusClass(item.status)}">${html(item.malformed ? "malformed" : item.status)}</span></td>
      <td>${html(timestamp(item.receivedAt))}</td>
    </tr>`).join("")}</tbody></table>`;
}

function render(data: DashboardData) {
  dashboard = data;
  const budget = data.budget;
  byId("spent").textContent = dollars(budget.totalCostMicros);
  byId("budget").textContent = dollars(budget.budgetMicros);
  byId("percentage").textContent = `${budget.percentageUsed.toFixed(1)}% used`;
  byId("remaining").textContent = `${dollars(budget.remainingMicros)} remaining`;
  const meter = byId<HTMLDivElement>("budget-meter");
  meter.style.width = `${Math.min(100, budget.percentageUsed)}%`;
  meter.style.background = budget.percentageUsed >= 90
    ? "var(--red)"
    : budget.percentageUsed >= 75 ? "var(--orange)" : "linear-gradient(90deg, var(--lime), #6de6a1)";
  const budgetState = byId("budget-state");
  const executionPaused = budget.paused || data.paidAiPaused;
  budgetState.textContent = budget.paused
    ? "Executions paused"
    : data.paidAiPaused ? "Paid AI paused" : "Protection active";
  budgetState.className = `status-pill${executionPaused ? " paused" : ""}`;
  byId("signal-title").textContent = executionPaused ? "Circuit breaker engaged" : "System healthy";
  byId("signal-copy").textContent = budget.paused
    ? "New model calls are blocked until an administrator resumes execution."
    : data.paidAiPaused
      ? "Paid model calls are blocked; eligible free Gemini work can continue."
    : "New tasks can be claimed and executed within the monthly limit.";

  const modelCalls = data.models.reduce((sum, item) => sum + Number(item.modelCalls ?? 0), 0);
  const totalTokens = data.models.reduce((sum, item) => sum + Number(item.totalTokens ?? 0), 0);
  const active = data.tasks.filter((task) =>
    task.orchestrationStatus === "claimed" || task.orchestrationStatus === "stale_recovered").length;
  const needsAction = data.tasks.filter((task) => task.orchestrationStatus === "needs_action").length;
  byId("metric-calls").textContent = integer(modelCalls);
  byId("metric-tokens").textContent = integer(totalTokens);
  byId("metric-active").textContent = integer(active);
  byId("metric-action").textContent = integer(needsAction);
  byId("metric-dead-letters").textContent = integer(data.deadLetters.length);

  byId("recent-tasks").innerHTML = taskTable(data.tasks, 7);
  byId("all-tasks").innerHTML = taskTable(data.tasks);
  byId("task-count").textContent = `${data.tasks.length} records`;
  byId("dead-letters").innerHTML = deadLetterTable(data.deadLetters);
  byId("dead-letter-count").textContent = `${data.deadLetters.length} records`;
  byId("generations").innerHTML = generationTable(data.generations);
  byId("generation-count").textContent = `${data.generations.length} records`;

  byId("alerts").innerHTML = data.alerts.length
    ? data.alerts.map((alert) => `<div class="stack-row"><span>${html(alert.threshold)}% threshold</span><strong>${dollars(Number(alert.totalCostMicros ?? 0))}</strong></div>`).join("")
    : '<div class="empty">No thresholds crossed this month.</div>';

  const maxModelCost = Math.max(1, ...data.models.map((item) => Number(item.estimatedCostMicros ?? 0)));
  byId("models").innerHTML = data.models.length
    ? data.models.sort((a, b) => Number(b.estimatedCostMicros ?? 0) - Number(a.estimatedCostMicros ?? 0)).map((model) => {
      const cost = Number(model.estimatedCostMicros ?? 0);
      return `<div class="model-row"><div><strong>${html(model.model)}</strong><div class="muted compact">${html(model.provider)} · ${integer(model.modelCalls)} calls · ${integer(model.totalTokens)} tokens</div></div><div class="model-bar"><div style="width:${(cost / maxModelCost) * 100}%"></div></div><strong>${dollars(cost, 6)}</strong></div>`;
    }).join("")
    : '<div class="empty">No model usage this month.</div>';

  byId("cost-sources").innerHTML = [
    ["AI recorded", budget.effectiveAiCostMicros],
    ["CSV reconciliation", budget.gatewayActualCostMicros],
    ["Google Cloud", budget.gcpCostMicros],
    ["Other", budget.otherCostMicros],
  ].map(([label, value]) => `<div class="stack-row"><span>${label}</span><strong>${dollars(Number(value), 6)}</strong></div>`).join("");
  const freshness = data.gcpCostFreshness;
  byId("gcp-freshness").textContent = freshness.status === "pending"
    ? "Google Cloud billing export is pending its first reconciliation."
    : `Google Cloud: ${freshness.status} · ${freshness.source} · ${timestamp(freshness.updatedAt)}${freshness.error ? ` · ${freshness.error}` : ""}`;
  const syncCopy = "Vercel cost is captured after every orchestrator request. Use a Vercel CSV total here for an independent reconciliation check.";
  byId("gateway-sync").textContent = syncCopy;
  byId("gateway-sync-control").textContent = syncCopy;

  byId<HTMLInputElement>("budget-input").value = String(budget.budgetMicros / 1_000_000);
  byId<HTMLInputElement>("paid-stop-input").value = String(data.paidAiCircuitBreakerMicros / 1_000_000);
  byId<HTMLInputElement>("threshold-input").value = data.thresholds.join(",");
  byId<HTMLInputElement>("paused-input").checked = budget.paused;
  byId<HTMLInputElement>("gateway-cost").value = String(budget.gatewayActualCostMicros / 1_000_000);
  byId<HTMLInputElement>("gcp-cost").value = String(budget.gcpCostMicros / 1_000_000);
  byId<HTMLInputElement>("other-cost").value = String(budget.otherCostMicros / 1_000_000);
}

async function loadDashboard() {
  if (!currentUser) return;
  try {
    render(await api(`/api/dashboard?month=${encodeURIComponent(monthInput.value)}`));
  } catch (error) {
    showMessage((error as Error).message, true);
  }
}

function selectView(name: string) {
  document.querySelectorAll(".nav-item").forEach((item) =>
    item.classList.toggle("active", (item as HTMLElement).dataset.view === name));
  document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
  byId(`view-${name}`).classList.add("active");
  byId("page-title").textContent = ({
    overview: "Overview",
    tasks: "Task execution",
    costs: "Costs & models",
    controls: "Budget controls",
  } as Record<string, string>)[name] ?? "Overview";
}

document.querySelectorAll(".nav-item").forEach((button) =>
  button.addEventListener("click", () => selectView((button as HTMLElement).dataset.view ?? "overview")));
document.querySelectorAll("[data-open-view]").forEach((button) =>
  button.addEventListener("click", () => selectView((button as HTMLElement).dataset.openView ?? "overview")));
byId("refresh").addEventListener("click", loadDashboard);
monthInput.addEventListener("change", loadDashboard);

byId("save-budget").addEventListener("click", async () => {
  try {
    const budgetUsd = Number(byId<HTMLInputElement>("budget-input").value);
    const thresholds = byId<HTMLInputElement>("threshold-input").value
      .split(",").map((value) => Number(value.trim()));
    await api("/api/budget", {
      method: "PUT",
      body: JSON.stringify({
        budgetMicros: Math.round(budgetUsd * 1_000_000),
        paidAiCircuitBreakerMicros: Math.round(
          Number(byId<HTMLInputElement>("paid-stop-input").value) * 1_000_000,
        ),
        thresholds,
        paused: byId<HTMLInputElement>("paused-input").checked,
      }),
    });
    showMessage("Budget protection updated.");
    await loadDashboard();
  } catch (error) { showMessage((error as Error).message, true); }
});

byId("save-costs").addEventListener("click", async () => {
  try {
    const micros = (id: string) => Math.round(Number(byId<HTMLInputElement>(id).value) * 1_000_000);
    await api(`/api/external-costs/${encodeURIComponent(monthInput.value)}`, {
      method: "PUT",
      body: JSON.stringify({
        gatewayActualCostMicros: micros("gateway-cost"),
        gcpCostMicros: micros("gcp-cost"),
        otherCostMicros: micros("other-cost"),
      }),
    });
    showMessage("Actual costs updated.");
    await loadDashboard();
  } catch (error) { showMessage((error as Error).message, true); }
});

const configResponse = await fetch("/api/config");
const { firebase } = await configResponse.json();
const firebaseApp = initializeApp(firebase);
const auth = getAuth(firebaseApp);
await setPersistence(auth, browserLocalPersistence);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

byId("sign-in").addEventListener("click", async () => {
  byId("login-error").textContent = "";
  try { await signInWithPopup(auth, provider); }
  catch (error) { byId("login-error").textContent = (error as Error).message; }
});
byId("sign-out").addEventListener("click", () => signOut(auth));

monthInput.value = new Date().toISOString().slice(0, 7);
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  login.classList.toggle("hidden", Boolean(user));
  appShell.classList.toggle("hidden", !user);
  if (!user) return;
  byId("user-name").textContent = user.displayName ?? "Signed in";
  byId("user-email").textContent = user.email ?? "";
  await loadDashboard();
});
