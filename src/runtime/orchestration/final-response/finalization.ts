import type {
  SessionMessageGrounding,
  SessionMessageObservationMeta,
  SessionThinkingTraceEntry,
} from "../../../sessions/types.js";
import type { AgentMode } from "../../../shared/types.js";
import type { EventSink, SessionStore } from "../../ports.js";
import { defaultRuntimeSessionStore } from "../../adapters/default-session-adapters.js";
import type { SessionTerminalMessage } from "../../../sessions/request-lifecycle/contracts.js";

export async function finalizeResponse(params: {
  events: EventSink;
  sessionStore?: Pick<SessionStore, "appendMessage">;
  sessionId: string;
  requestId: string;
  agentMode: AgentMode;
  output: string;
  grounding?: SessionMessageGrounding;
  observationMeta?: SessionMessageObservationMeta;
  observationContent?: string;
  thinkingTrace?: SessionThinkingTraceEntry[];
  afterPersist?: () => void;
  persistResponse?: (message: SessionTerminalMessage) => Promise<void>;
}): Promise<void> {
  const sessionStore = params.sessionStore ?? defaultRuntimeSessionStore;
  const metadata = {
    lastAgentMode: params.agentMode,
    requestId: params.requestId,
    ...(params.grounding ? { grounding: params.grounding } : {}),
    ...(params.observationMeta
      ? { observationMeta: params.observationMeta }
      : {}),
    ...(params.observationContent
      ? { observationContent: params.observationContent }
      : {}),
    ...(params.thinkingTrace ? { thinkingTrace: params.thinkingTrace } : {}),
  };
  if (params.persistResponse) {
    await params.persistResponse({ content: params.output, ...metadata });
  } else {
    await sessionStore.appendMessage(
      params.sessionId,
      "assistant",
      params.output,
      metadata,
    );
  }
  params.afterPersist?.();
  params.events.event("thinking.completed");
  params.events.completed(params.output);
}
