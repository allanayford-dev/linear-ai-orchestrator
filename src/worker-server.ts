import { Firestore } from "@google-cloud/firestore";
import { BigQuery } from "@google-cloud/bigquery";
import { createWorkerApp } from "./worker-app.js";
import { loadWorkerConfig } from "./config/worker-env.js";
import { FirestoreWorkerRepository } from "./repositories/firestore-worker-repository.js";
import { PauseAwareWorkerRepository } from "./repositories/pause-aware-worker-repository.js";
import { FirestoreDeadLetterRepository } from "./repositories/firestore-dead-letter-repository.js";
import { VercelAiGatewayClient } from "./services/ai-gateway-client.js";
import { GeminiClient } from "./services/gemini-client.js";
import { LinearGraphQlClient } from "./services/linear-client.js";
import { OrchestratorWorkerService } from "./services/orchestrator-worker-service.js";
import { DeadLetterService } from "./services/dead-letter-service.js";
import { BigQueryGcpBillingClient } from "./services/bigquery-gcp-billing-client.js";
import { GcpCostReconciliationService } from "./services/gcp-cost-reconciliation-service.js";
import { FirestoreGcpCostRepository } from "./repositories/firestore-gcp-cost-repository.js";

const config = loadWorkerConfig();
const firestoreOptions = {
  databaseId: config.databaseId,
  ...(config.projectId ? { projectId: config.projectId } : {}),
};
const firestore = new Firestore(firestoreOptions);
const firestoreRepository = new FirestoreWorkerRepository(
  firestore,
  config.maxSystemMonthlyCostMicros,
  config.paidAiCircuitBreakerMicros,
);
const repository = new PauseAwareWorkerRepository(firestore, firestoreRepository);
const worker = new OrchestratorWorkerService(
  config,
  repository,
  new LinearGraphQlClient(config.linearApiKey),
  new GeminiClient(config.geminiApiKey),
  new VercelAiGatewayClient(config.aiGatewayApiKey),
);
const deadLetters = new DeadLetterService(
  new FirestoreDeadLetterRepository(firestore),
);
const bigQuery = new BigQuery(config.projectId ? { projectId: config.projectId } : {});
const billingClient = new BigQueryGcpBillingClient({
  async query(options) {
    const [rows] = await bigQuery.query(options);
    return [rows as Array<Record<string, unknown>>];
  },
}, config.gcpBilling);
const gcpCosts = new GcpCostReconciliationService(
  billingClient,
  new FirestoreGcpCostRepository(
    firestore,
    config.maxSystemMonthlyCostMicros,
    config.paidAiCircuitBreakerMicros,
  ),
  config.gcpBilling.table,
  config.gcpBilling.projectId,
);

createWorkerApp(worker, deadLetters, gcpCosts).listen(config.port, "0.0.0.0", () => {
  console.log(`orchestrator-worker listening on port ${config.port}`);
});
