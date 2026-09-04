import type { ConversationSourcesGroup } from "../lib/web-sources.js";

export declare function createConversationSources(options?: {
  documentRoot?: Document;
}): {
  createNode(groups?: ConversationSourcesGroup[]): HTMLElement | null;
};
