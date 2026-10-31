import type { ConversationSessionState } from "../controllers/conversation-session-controller.js";

export declare function applyUserInteractionEvent(
  state: Pick<ConversationSessionState, "currentSessionId" | "sessionViewVersion" | "messages" | "requestLifecycles">,
  event: Record<string, unknown>,
  environmentId: string,
): boolean;

export declare function orderRequestInteractionMessages(
  messages: ConversationSessionState["messages"],
): ConversationSessionState["messages"];

export declare function acceptsUserInteractionScope(
  state: Pick<ConversationSessionState, "currentSessionId" | "sessionViewVersion" | "requestLifecycles">,
  event: Record<string, unknown>,
  environmentId: string,
): boolean;
