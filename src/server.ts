import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { FirestoreWebhookRepository } from "./repositories/firestore-webhook-repository.js";
import { LinearWebhookService } from "./services/linear-webhook-service.js";
import { PubSubEventPublisher } from "./services/pubsub-event-publisher.js";

const config = loadConfig();
const googleClientOptions = config.gcpProjectId
  ? { projectId: config.gcpProjectId }
  : {};
const firestore = new Firestore({
  ...googleClientOptions,
  databaseId: config.firestoreDatabaseId,
  ignoreUndefinedProperties: true,
});
const pubsub = new PubSub(googleClientOptions);
const repository = new FirestoreWebhookRepository(firestore);
const publisher = new PubSubEventPublisher(pubsub, config.pubsubTopic);
const webhookService = new LinearWebhookService(repository, publisher);
const app = createApp({ config, webhookService });

app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      severity: "INFO",
      message: "linear-webhook listening",
      port: config.port,
      environment: config.nodeEnv,
    }),
  );
});
