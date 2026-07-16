import { getApp, getApps } from "firebase/app";
import { getAuth, onAuthStateChanged, type User } from "firebase/auth";

type RecordValue = Record<string, unknown>;

interface DashboardData {
  projects: RecordValue[];
  models: RecordValue[];
  generations: RecordValue[];
}

interface UsageSummary {
  label: string;
  calls: number;
  tokens: number;
  costMicros: number;
}

const byId = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const html = (value: unknown) => String(value ?? "—")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const integer = (value: unknown) => Number(value ?? 0).toLocaleString();
const dollars = (micros: number, precision = 6) =>
  (micros / 1_000_000).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });

const timestamp = (value: unknown) => {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

function summarize(
  items: RecordValue[],
  key: (item: RecordValue) => string,
): UsageSummary[] {
  const totals = new Map<string, UsageSummary>();
  for (const item of items) {
    const label = key(item) || "Unknown";
    const current = totals.get(label) ?? {
      label,
      calls: 0,
      tokens: 0,
      costMicros: 0,
    };
    current.calls += Number(item.modelCalls ?? 0);
    current.tokens += Number(item.totalTokens ?? 0);
    current.costMicros += Number(item.estimatedCostMicros ?? 0);
    totals.set(label, current);
  }
  return [...totals.values()].sort((left, right) =>
    right.costMicros - left.costMicros || right.calls - left.calls);
}

function summarizeGenerationsByTask(items: RecordValue[]): UsageSummary[] {
  const totals = new Map<string, UsageSummary>();
  for (const item of items) {
    const label = String(item.issueIdentifier ?? "Unknown");
    const current = totals.get(label) ?? {
      label,
      calls: 0,
      tokens: 0,
      costMicros: 0,
    };
    current.calls += 1;
    current.tokens += Number(item.totalTokens ?? 0);
    current.costMicros += Number(item.estimatedCostMicros ?? 0);
    totals.set(label, current);
  }
  return [...totals.values()].sort((left, right) =>
    right.costMicros - left.costMicros || right.calls - left.calls);
}

function usageRows(items: UsageSummary[], emptyMessage: string): string {
  if (!items.length) return `<div class="empty">${html(emptyMessage)}</div>`;
  return items.map((item) => `
    <div class="stack-row">
      <span>${html(item.label)}<span class="muted compact"> · ${integer(item.calls)} calls · ${integer(item.tokens)} tokens</span></span>
      <strong>${dollars(item.costMicros)}</strong>
    </div>`).join("");
}

function fallbackTable(items: RecordValue[]): string {
  if (!items.length) return '<div class="empty">No fallback generations recorded for the selected month.</div>';
  return `<table><thead><tr><th>Issue</th><th>Role</th><th>Fallback provider / model</th><th>Attempt</th><th>Tokens</th><th>Cost</th><th>Updated</th></tr></thead><tbody>${items.map((item) => `
    <tr>
      <td>${html(item.issueIdentifier)}</td>
      <td>${html(item.role)}</td>
      <td>${html(item.provider)} / ${html(item.model)}</td>
      <td>${integer(item.attempt)}</td>
      <td>${integer(item.totalTokens)}</td>
      <td>${dollars(Number(item.estimatedCostMicros ?? 0))}</td>
      <td>${html(timestamp(item.updatedAt))}</td>
    </tr>`).join("")}</tbody></table>`;
}

async function loadCostMonitor(user: User): Promise<void> {
  const monthInput = byId<HTMLInputElement>("month");
  if (!monthInput.value) monthInput.value = new Date().toISOString().slice(0, 7);
  const token = await user.getIdToken();
  const response = await fetch(`/api/dashboard?month=${encodeURIComponent(monthInput.value)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return;
  const data = await response.json() as DashboardData;

  const projectUsage = summarize(
    data.projects,
    (item) => String(item.projectName ?? item.projectId ?? "Unknown project"),
  );
  const taskUsage = summarizeGenerationsByTask(data.generations);
  const providerUsage = summarize(
    data.models,
    (item) => String(item.provider ?? "Unknown provider"),
  );
  const pricingUsage = summarize(
    data.models,
    (item) => String(item.pricingTier ?? "unknown").toLowerCase(),
  );
  const fallbacks = data.generations
    .filter((item) => Number(item.attempt ?? 1) > 1)
    .slice(0, 20);

  byId("project-usage").innerHTML = usageRows(projectUsage, "No project usage recorded this month.");
  byId("task-usage").innerHTML = usageRows(taskUsage, "No task usage recorded this month.");
  byId("provider-usage").innerHTML = usageRows(providerUsage, "No provider usage recorded this month.");
  byId("pricing-usage").innerHTML = usageRows(pricingUsage, "No free or paid usage recorded this month.");
  byId("fallbacks").innerHTML = fallbackTable(fallbacks);
  byId("fallback-count").textContent = `${fallbacks.length} recent records`;
}

async function waitForDashboardFirebaseApp() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getApps().length > 0) return getApp();
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  }
  throw new Error("Dashboard Firebase app did not initialize");
}

const app = await waitForDashboardFirebaseApp();
const auth = getAuth(app);

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  await loadCostMonitor(user);
});

byId("month").addEventListener("change", async () => {
  if (auth.currentUser) await loadCostMonitor(auth.currentUser);
});
byId("refresh").addEventListener("click", async () => {
  if (auth.currentUser) await loadCostMonitor(auth.currentUser);
});
