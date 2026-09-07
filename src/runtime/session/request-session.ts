import type { ModelGatewayAttachment } from "../../model-gateway/types.js";
import type { SessionRecord } from "../../sessions/types.js";
import type { AgentMode } from "../../shared/types.js";
import type {
  RuntimeAttachmentReference,
  RuntimeAttachmentStore,
} from "../attachments/store.js";
import type { EventSink } from "../ports.js";
import { appendRequestAttachmentManifest } from "../orchestration/request/request-attachment-prompt.js";
import {
  resolveModelGatewayAttachments,
  resolveRequestAttachments,
  resolveToolRequestAttachments,
} from "../orchestration/request/request-attachments.js";
import type { ToolRequestAttachment } from "../../capabilities/tool-types.js";
import type { RequestSessionStore } from "../request/session-store.js";

type OpenedRequestSession = {
  session: SessionRecord;
  attachments: RuntimeAttachmentReference[];
};

export async function openRequestSession(params: {
  sessionId: string;
  requestId: string;
  rawAttachments: unknown;
  sessionStore: RequestSessionStore;
  attachmentStore?: RuntimeAttachmentStore;
}): Promise<OpenedRequestSession> {
  if (!params.sessionId) {
    throw new Error("sessionId required");
  }

  const session = await params.sessionStore.getOrCreateSession(
    params.sessionId,
  );
  const attachments = await resolveRequestAttachments({
    rawAttachments: params.rawAttachments,
    sessionId: params.sessionId,
    attachmentStore: params.attachmentStore,
  });
  await params.sessionStore.startRequestStream(
    params.sessionId,
    params.requestId,
  );

  return { session, attachments };
}

export async function initializeRequestSession(params: {
  opened: OpenedRequestSession;
  sessionId: string;
  requestId: string;
  prompt: string;
  agentMode: AgentMode;
  sessionStore: RequestSessionStore;
  attachmentStore?: RuntimeAttachmentStore;
  events: EventSink;
  schedule?: import("../../sessions/schedule-metadata.js").ScheduleMessageReference;
}): Promise<
  Readonly<{
    prompt: string;
    modelAttachments: ModelGatewayAttachment[];
    toolAttachments: readonly ToolRequestAttachment[];
  }>
> {
  params.events.event("thinking.started");

  const persisted = await params.sessionStore.appendMessage(
    params.sessionId,
    "user",
    params.prompt,
    {
      lastAgentMode: params.agentMode,
      requestId: params.requestId,
      ...(params.schedule
        ? { source: "cron" as const, schedule: params.schedule }
        : {}),
      ...(params.opened.attachments.length > 0
        ? { attachments: params.opened.attachments }
        : {}),
    },
  );

  if (params.schedule) {
    const message = persisted.messages.find(
      (entry) => entry.requestId === params.requestId && entry.role === "user",
    );
    params.events.event("schedule.triggered", {
      sessionId: params.sessionId,
      schedule: params.schedule,
      messageId: message?.id,
      text: params.prompt,
      createdAt: message?.createdAt,
    });
  }

  const [modelAttachments, toolAttachments] = await Promise.all([
    resolveModelGatewayAttachments({
      attachments: params.opened.attachments,
      attachmentStore: params.attachmentStore,
    }),
    resolveToolRequestAttachments({
      attachments: params.opened.attachments,
      attachmentStore: params.attachmentStore,
    }),
  ]);
  return Object.freeze({
    prompt: appendRequestAttachmentManifest(params.prompt, toolAttachments),
    modelAttachments,
    toolAttachments,
  });
}
