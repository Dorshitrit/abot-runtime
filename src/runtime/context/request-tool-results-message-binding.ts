import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestToolResultsView } from "./request-tool-results.js";

const REQUEST_TOOL_RESULTS_MESSAGE_AUTHORITY = Symbol(
  "requestToolResultsMessageAuthority",
);

type RequestToolResultsMessageAuthority = Readonly<{
  message: object;
  view: RequestToolResultsView;
}>;

/** Mints one frozen message bound to its exact canonical result view. */
export function bindRequestToolResultsMessage(
  view: RequestToolResultsView,
  content: string,
): ChatMessage {
  const message = { role: "user" as const, content };
  const authority = Object.freeze({ message, view });
  Object.defineProperty(message, REQUEST_TOOL_RESULTS_MESSAGE_AUTHORITY, {
    value: authority,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(message);
}

/** Accepts only a message minted for this exact canonical result view. */
export function isRequestToolResultsMessageBoundToView(
  message: ChatMessage,
  view: RequestToolResultsView,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(
    message,
    REQUEST_TOOL_RESULTS_MESSAGE_AUTHORITY,
  );
  if (!descriptor) return false;
  const authority: unknown = descriptor.value;
  if (typeof authority !== "object" || authority === null) return false;
  if (!Object.isFrozen(authority)) return false;
  const candidate = authority as RequestToolResultsMessageAuthority;
  return (
    candidate.message === message &&
    candidate.view === view &&
    descriptor.enumerable === false &&
    descriptor.configurable === false &&
    descriptor.writable === false
  );
}
