import { isStrictTextChatMessage } from "../../protocol/message-contract.js";
import type { ModelGatewayRequest } from "../../types.js";
import type { LlamaCppChatPayload } from "./payload.js";
import { mergeLeadingLlamaCppSystemMessages } from "./system-message-render.js";

export type SystemMessageLayout = Readonly<{
  kind: "original" | "merged_opening" | "context_first" | "context_first_merged";
  payload: LlamaCppChatPayload;
  probePayload: LlamaCppChatPayload;
  mergeLeading: boolean;
}>;

/** The caller's indices refer to its own messages, before provider calibration. */
export function readLlamaCppInvocationContextIndices(request: ModelGatewayRequest): ReadonlySet<number> | undefined {
  const indices = request.invocationContextMessageIndices;
  if (indices === undefined) return new Set();
  if (!Array.isArray(indices)) return undefined;
  if (!indices.length) return new Set();
  const messages = request.messages;
  if (!Array.isArray(messages) || indices.length > messages.length) return undefined;

  const selected = new Set<number>();
  for (const index of indices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= messages.length || selected.has(index)) return undefined;
    const message: unknown = messages[index];
    if (!isStrictTextChatMessage(message) || message.role !== "system" || message.attachments?.length) return undefined;
    selected.add(index);
  }
  return selected;
}

function joinedLayout(probePayload: LlamaCppChatPayload, kind: SystemMessageLayout["kind"]): SystemMessageLayout {
  return {
    kind, probePayload,
    payload: { ...probePayload, messages: mergeLeadingLlamaCppSystemMessages(probePayload.messages) },
    mergeLeading: true,
  };
}

/** Try the canonical order before moving expressly selected references to the invocation header. */
export function* llamaCppSystemMessageLayouts(
  payload: LlamaCppChatPayload,
  contextIndices: ReadonlySet<number>,
  originalMessageCount: number,
): Generator<SystemMessageLayout> {
  yield { kind: "original", payload, probePayload: payload, mergeLeading: false };
  const { messages } = payload;
  if (messages[0]?.role !== "system") return;
  if (messages[1]?.role === "system") yield joinedLayout(payload, "merged_opening");
  if (!contextIndices.size) return;
  const firstTurn = messages.findIndex((message) => message.role !== "system");
  if (firstTurn < 0) return;

  // The projection copies each original message once and prepends any profile instructions.
  const offset = messages.length - originalMessageCount;
  const references: typeof messages = [];
  const turns: typeof messages = [];
  for (let index = firstTurn; index < messages.length; index++) {
    const destination = contextIndices.has(index - offset) ? references : turns;
    destination.push(messages[index]!);
  }
  if (!references.length) return;
  const relocated = { ...payload, messages: [...messages.slice(0, firstTurn), ...references, ...turns] };
  yield { kind: "context_first", payload: relocated, probePayload: relocated, mergeLeading: false };
  yield joinedLayout(relocated, "context_first_merged");
}
