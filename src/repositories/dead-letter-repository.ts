export type DeadLetterWriteResult = "recorded" | "duplicate";

export interface DeadLetterRecord {
  id: string;
  messageId: string | null;
  deadLetterSubscription: string | null;
  sourceSubscription: string | null;
  sourceSubscriptionProject: string | null;
  sourceDeliveryCount: number | null;
  sourceTopicPublishTime: string | null;
  publishTime: string | null;
  deliveryId: string | null;
  issueIdentifier: string | null;
  attributes: Record<string, string>;
  dataBase64: string | null;
  decodedData: unknown;
  malformed: boolean;
  validationErrors: string[];
}

export interface DeadLetterRepository {
  record(record: DeadLetterRecord): Promise<DeadLetterWriteResult>;
}
