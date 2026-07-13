import { Firestore } from "@google-cloud/firestore";
import { createWorkerApp } from "./worker-app.js";
import { loadWorkerConfig } from "./config/worker-env.js";
import { FirestoreWorkerRepository } from "./repositories/firestore-worker-repository.js";
import { FirestoreDashboardRepository } from "./repositories/firestore-dashboard-repository.js";
import { VercelAiGatewayClient } from "./services/ai-gateway-client.js";
import { GeminiClient } from "./services/gemini-client.js";
import { LinearGraphQlClient } from "./services/linear-client.js";
import { OrchestratorWorkerService } from "./services/orchestrator-worker-service.js";
import { DEFAULT_ALERT_THRESHOLDS } from "./services/budget-policy.js";
import { VercelCostReconciliationService } from "./services/vercel-cost-reconciliation-service.js";
import { VercelReportClient } from "./services/vercel-report-client.js";

const config = loadWorkerConfig();
const firestoreOptions = {
  databaseId: config.databaseId,
  ...(config.projectId ? { projectId: config.projectId } : {}),
};
const firestore = new Firestore(firestoreOptions);
const repository = new FirestoreWorkerRepository(
  firestore,
  config.maxSystemMonthlyCostMicros,
  config.paidAiCircuitBreakerMicros,
);
const costRepository = new FirestoreDashboardRepository(
  firestore,
  config.maxSystemMonthlyCostMicros,
  DEFAULT_ALERT_THRESHOLDS,
);
const worker = new OrchestratorWorkerService(
  config,
  repository,
  new LinearGraphQlClient(config.linearApiKey),
  new GeminiClient(config.geminiApiKey),
  new VercelAiGatewayClient(config.aiGatewayApiKey),
);

const reconciliation = new VercelCostReconciliationService(
  new VercelReportClient(config.aiGatewayApiKey),
  costRepository,
);

createWorkerApp(worker, reconciliation).listen(config.port, "0.0.0.0", () => {
  console.log(`orchestrator-worker listening on port ${config.port}`);
});
