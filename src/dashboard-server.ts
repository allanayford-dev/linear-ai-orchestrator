import { Firestore } from "@google-cloud/firestore";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { createDashboardApp } from "./dashboard-app.js";
import { loadDashboardConfig } from "./config/dashboard-env.js";
import { AuditedDashboardRepository } from "./repositories/audited-dashboard-repository.js";
import { FirestoreDashboardRepository } from "./repositories/firestore-dashboard-repository.js";
import { DashboardService } from "./services/dashboard-service.js";

const config = loadDashboardConfig();
const firebaseApp = getApps()[0] ?? initializeApp({ projectId: config.projectId });
const firestore = new Firestore({
  projectId: config.projectId,
  databaseId: config.databaseId,
});
const firestoreRepository = new FirestoreDashboardRepository(
  firestore,
  config.defaultBudgetMicros,
  config.defaultAlertThresholds,
);
const repository = new AuditedDashboardRepository(firestore, firestoreRepository);

createDashboardApp({
  service: new DashboardService(repository),
  verifier: getAuth(firebaseApp),
  allowedEmails: config.allowedEmails,
  firebase: config.firebase,
}).listen(config.port, "0.0.0.0", () => {
  console.log(`orchestrator-dashboard listening on port ${config.port}`);
});
