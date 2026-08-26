import { readFile } from "node:fs/promises";

import type { ModelGatewayAttachment } from "../../../model-gateway/types.js";
import type { ToolRequestAttachment } from "../../../capabilities/tool-types.js";
import type {
  RuntimeAttachmentReference,
  RuntimeAttachmentStore,
} from "../../attachments/store.js";
import { parseRuntimeAttachmentReferences } from "../../attachments/store.js";

export {
  resolvedModelStepImageAttachmentProfileId,
  resolvedModelStepSupportsImageAttachments,
} from "../../model/model-step-capability-policy.js";

export const MAX_REQUEST_ATTACHMENTS = 4;

function dedupeAttachmentReferences(
  attachments: RuntimeAttachmentReference[],
): RuntimeAttachmentReference[] {
  const seen = new Set<string>();
  const deduped: RuntimeAttachmentReference[] = [];
  for (const attachment of attachments) {
    const key = attachment.storageRef;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(attachment);
  }
  return deduped;
}

function enforceAttachmentCountLimit(
  attachments: RuntimeAttachmentReference[],
): RuntimeAttachmentReference[] {
  const deduped = dedupeAttachmentReferences(attachments);
  if (deduped.length > MAX_REQUEST_ATTACHMENTS) {
    throw new Error("attachment_count_exceeded");
  }
  return deduped;
}

export async function resolveRequestAttachments(params: {
  rawAttachments: unknown;
  sessionId: string;
  attachmentStore?: RuntimeAttachmentStore;
}): Promise<RuntimeAttachmentReference[]> {
  const attachments = enforceAttachmentCountLimit(
    parseRuntimeAttachmentReferences(params.rawAttachments),
  );
  if (attachments.length === 0) {
    return [];
  }
  if (!params.attachmentStore) {
    throw new Error("attachment_store_unavailable");
  }
  return params.attachmentStore.validateAttachmentReferences(attachments, {
    sessionId: params.sessionId,
  });
}

export async function resolveModelGatewayAttachments(params: {
  attachments: RuntimeAttachmentReference[];
  attachmentStore?: RuntimeAttachmentStore;
}): Promise<ModelGatewayAttachment[]> {
  const attachments = enforceAttachmentCountLimit(params.attachments).filter(
    (attachment) => attachment.kind === "image",
  );
  if (attachments.length === 0) {
    return [];
  }
  if (!params.attachmentStore) {
    throw new Error("attachment_store_unavailable");
  }
  return Promise.all(
    attachments.map(async (attachment) => {
      const resolved =
        await params.attachmentStore!.resolveAttachment(attachment);
      const data = await readFile(resolved.absolutePath, "base64");
      return {
        id: attachment.id,
        kind: attachment.kind,
        mimeType: attachment.mimeType,
        storageRef: attachment.storageRef,
        data,
        ...(attachment.name ? { name: attachment.name } : {}),
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      };
    }),
  );
}

export async function resolveToolRequestAttachments(params: {
  attachments: RuntimeAttachmentReference[];
  attachmentStore?: RuntimeAttachmentStore;
}): Promise<readonly ToolRequestAttachment[]> {
  const attachments = enforceAttachmentCountLimit(params.attachments).filter(
    (attachment) => attachment.kind === "file",
  );
  if (attachments.length === 0) {
    return Object.freeze([]);
  }
  if (!params.attachmentStore) {
    throw new Error("attachment_store_unavailable");
  }
  const resolved = await Promise.all(
    attachments.map(async (attachment) => {
      const value = await params.attachmentStore!.resolveAttachment(attachment);
      return Object.freeze({
        id: value.metadata.id,
        kind: value.metadata.kind,
        mimeType: value.metadata.mimeType,
        absolutePath: value.absolutePath,
        ...(value.metadata.name ? { name: value.metadata.name } : {}),
        ...(value.metadata.size !== undefined
          ? { size: value.metadata.size }
          : {}),
      } satisfies ToolRequestAttachment);
    }),
  );
  return Object.freeze(resolved);
}
