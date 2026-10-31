import type { IncomingMessage } from "node:http";
import { hasSameOrigin } from "./config-mutation-request.js";
import type { RuntimeAttachmentReference } from "../../shared/attachments.js";
import type { InformationBasketManagement } from "../../runtime/local-host/client-information-basket.js";
import { traceDebug } from "../../runtime/observability/debug-logger.js";

function canRegisterChatUploadRequest(request: IncomingMessage): boolean {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  return hasSameOrigin(request);
}

/** Registration failure must never turn a saved chat upload into a failed upload. */
export async function captureAttachmentResourceRegistration(request: IncomingMessage, service: InformationBasketManagement | undefined) {
  if (!canRegisterChatUploadRequest(request)) return undefined;
  try {
    const settingsRevision = await service?.captureChatUpload();
    if (settingsRevision == null) return undefined;
    return async (attachment: RuntimeAttachmentReference, sessionId: string): Promise<void> => {
      try { await service!.registerChatUpload({ attachment, sessionId, settingsRevision }); }
      catch { traceDebug("runtime.information_basket", "chat_upload.registration_failed", {}); }
    };
  } catch {
    traceDebug("runtime.information_basket", "chat_upload.admission_failed", {});
    return undefined;
  }
}
