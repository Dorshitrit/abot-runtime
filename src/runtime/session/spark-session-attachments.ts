import type { SessionRecord } from "../../sessions/types.js";
import type { RuntimeAttachmentStore } from "../attachments/store.js";
import { createSparkCleanupReceipt } from "./spark-session-cleanup-receipt.js";

/** Capture only transcript-owned files; a simultaneous new upload is a different reference. */
export async function prepareSparkAttachmentCleanup(
  attachments: RuntimeAttachmentStore | undefined,
  session: SessionRecord | null,
  runtimeDirectory?: string,
): Promise<() => Promise<void>> {
  const receipt = runtimeDirectory ? createSparkCleanupReceipt(runtimeDirectory) : undefined;
  const pending = await receipt?.read() ?? [];
  const captured = (session?.messages ?? []).flatMap((message) => message.attachments ?? []);
  const references = [...new Map([...pending, ...captured]
    .map((attachment) => [attachment.storageRef, attachment])).values()];
  if (references.length === 0) return async () => {};
  const deleteAttachment = attachments?.deleteAttachment?.bind(attachments);
  if (!deleteAttachment) throw new Error("spark_chat_attachment_cleanup_unavailable");
  if (!receipt) throw new Error("spark_chat_cleanup_receipt_unavailable");
  // Persist before transcript removal. A failed deletion never loses its retry reference.
  await receipt.save(references);
  return async () => {
    const outcomes = await Promise.allSettled(references.map((reference) =>
      deleteAttachment(reference, { sessionId: session!.id })));
    const failed = outcomes.find(isAttachmentCleanupFailure);
    if (failed) throw failed.reason;
    await receipt.complete();
  };
}

function isAttachmentCleanupFailure(outcome: PromiseSettledResult<void>): outcome is PromiseRejectedResult {
  return outcome.status === "rejected";
}
