import { FieldValue, Firestore } from "@google-cloud/firestore";
import type {
  DeadLetterRecord,
  DeadLetterRepository,
  DeadLetterWriteResult,
} from "./dead-letter-repository.js";

export class FirestoreDeadLetterRepository implements DeadLetterRepository {
  constructor(private readonly firestore: Firestore) {}

  async record(record: DeadLetterRecord): Promise<DeadLetterWriteResult> {
    const ref = this.firestore.collection("dead_letters").doc(record.id);
    return this.firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) return "duplicate";
      transaction.create(ref, {
        ...record,
        status: "unresolved",
        receivedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return "recorded";
    });
  }
}
