import type { BasketChatUpload, InformationBasketOptions } from "./contracts.js";
import type { BasketSnapshot } from "./index-records.js";
import { isBasketSupportedPath } from "./source-reader.js";
import type { createBasketSourceRegistration } from "./source-registration.js";
import type { BasketStateOwner } from "./state-owner.js";

/** Upload admission is captured before bytes arrive; settings changes revoke it. */
export function createBasketChatUploads(options: {
  state: BasketStateOwner;
  attachments: InformationBasketOptions["attachments"];
  register: ReturnType<typeof createBasketSourceRegistration>;
  isStarted(): boolean;
}) {
  function canRegisterChatUpload(snapshot: BasketSnapshot, revision: number): boolean {
    if (!options.isStarted() || !options.attachments) return false;
    if (!snapshot.settings.indexChatUploads) return false;
    return snapshot.settings.revision === revision;
  }
  return {
    async captureChatUpload(): Promise<number | null> {
      const snapshot = await options.state.read();
      return canRegisterChatUpload(snapshot, snapshot.settings.revision) ? snapshot.settings.revision : null;
    },
    async registerChatUpload(input: BasketChatUpload): Promise<void> {
      const snapshot = await options.state.read();
      if (!canRegisterChatUpload(snapshot, input.settingsRevision)) return;
      if (input.attachment.kind !== "file" || !isBasketSupportedPath(input.attachment.storageRef)) return;
      const [validated] = await options.attachments!.validateAttachmentReferences([input.attachment], { sessionId: input.sessionId });
      if (!validated) return;
      const resolved = await options.attachments!.resolveAttachment(validated);
      await options.register([{ path: resolved.absolutePath, displayName: validated.name }],
        current => canRegisterChatUpload(current, input.settingsRevision));
    },
  };
}
