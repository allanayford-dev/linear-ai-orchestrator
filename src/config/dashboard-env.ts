import { DEFAULT_ALERT_THRESHOLDS } from "../services/budget-policy.js";

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId?: string;
}

export interface DashboardConfig {
  port: number;
  projectId: string;
  databaseId: string;
  allowedEmails: string[];
  defaultBudgetMicros: number;
  defaultAlertThresholds: number[];
  firebase: FirebaseWebConfig;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function loadDashboardConfig(): DashboardConfig {
  const projectId = process.env.GCP_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim() || required("FIREBASE_PROJECT_ID");
  const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID?.trim();
  const allowedEmails = list("DASHBOARD_ALLOWED_EMAILS");
  if (allowedEmails.length === 0) {
    throw new Error("DASHBOARD_ALLOWED_EMAILS must contain at least one email");
  }
  return {
    port: integer("PORT", 8080),
    projectId,
    databaseId: process.env.FIRESTORE_DATABASE_ID?.trim() || "(default)",
    allowedEmails,
    defaultBudgetMicros: integer(
      "MAX_SYSTEM_MONTHLY_COST_MICROS",
      20_000_000,
    ),
    defaultAlertThresholds: [...DEFAULT_ALERT_THRESHOLDS],
    firebase: {
      apiKey: required("FIREBASE_API_KEY"),
      authDomain: required("FIREBASE_AUTH_DOMAIN"),
      projectId,
      appId: required("FIREBASE_APP_ID"),
      ...(messagingSenderId ? { messagingSenderId } : {}),
    },
  };
}
