import { createHash } from "node:crypto";
import { isAssistantInitiativeMessage } from "../../sessions/assistant-initiative.js";
import { toSnapshotMessage } from "../../sessions/record/projection.js";
import { isSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { isSparkHandoffBrief } from "../../sessions/spark-handoff-brief.js";
import type { SessionRecord } from "../../sessions/types.js";
import type { RuntimeEnvironment, JsonObject } from "./contracts.js";
import type { SparkChatRouteRequest } from "./spark-chat-routes.js";
import type { WorkspaceChangeNotifier } from "./workspace-notifications.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";

type MessageReference = { id: string; createdAt: number; requestId: string | null };

const failures: Record<string, { status: number; message: string }> = {
  spark_handoff_reference_invalid: { status: 400, message: "The SPARK message reference is invalid. Refresh the chat and try again." },
  spark_handoff_source_unavailable: { status: 409, message: "This SPARK insight is no longer in the chat. Refresh the chat to see the current messages." },
  spark_handoff_brief_unavailable: { status: 409, message: "This older SPARK insight does not have saved context for a new session." },
  spark_handoff_target_conflict: { status: 409, message: "The session for this insight was cleared or changed and cannot be reopened from this message." },
  spark_handoff_unavailable: { status: 503, message: "Opening a session from SPARK is unavailable in this environment." },
  spark_handoff_failed: { status: 500, message: "The session could not be opened. Try again." },
};

function readMessageReference(body: JsonObject | null): MessageReference {
  const input = body?.message;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("spark_handoff_reference_invalid");
  const value = input as Record<string, unknown>;
  const validId = typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200;
  const validTimestamp = typeof value.createdAt === "number" && Number.isFinite(value.createdAt);
  const validRequest = value.requestId === null || (typeof value.requestId === "string" && value.requestId.length > 0 && value.requestId.length <= 200);
  if (!validId || !validTimestamp || !validRequest) throw new Error("spark_handoff_reference_invalid");
  return { id: value.id as string, createdAt: value.createdAt as number, requestId: value.requestId as string | null };
}

function findSourceMessage(session: SessionRecord | null, reference: MessageReference) {
  if (!session || !isSparkSession(session)) throw new Error("spark_handoff_source_unavailable");
  const message = session.messages.find((candidate) => {
    if (!isAssistantInitiativeMessage(candidate)) return false;
    const projected = toSnapshotMessage(session.id, candidate, session.requests ?? []);
    return String(projected.id) === reference.id && projected.createdAt === reference.createdAt && projected.requestId === reference.requestId;
  });
  if (!message) throw new Error("spark_handoff_source_unavailable");
  return message;
}

function handoffFailure(error: unknown) {
  const original = error instanceof Error ? error.message : "";
  const deleted = !!error && typeof error === "object" && "code" in error && error.code === "session_deleted";
  if (deleted || original === "assistant_conversation_identity_conflict") return "spark_handoff_target_conflict";
  return Object.hasOwn(failures, original) ? original : "spark_handoff_failed";
}

export async function handleSparkChatHandoff(
  input: SparkChatRouteRequest,
  resolveEnvironment: (id: string) => RuntimeEnvironment,
  notify?: WorkspaceChangeNotifier,
): Promise<boolean> {
  if (input.route !== "runtime/spark/chat/sessions") return false;
  input.response.setHeader("cache-control", "no-store");
  if (input.method !== "POST") {
    input.response.setHeader("allow", "POST");
    sendJson(input.response, 405, { ok: false, error: "method_not_allowed" });
    return true;
  }
  if (!acceptConfigMutationRequest(input.request, input.response)) return true;
  try {
    const reference = readMessageReference(input.body);
    const { sessions } = resolveEnvironment(input.environmentId).services;
    const source = findSourceMessage(await sessions.getSessionById(SPARK_SESSION_ID), reference);
    const initiative = source.initiative!;
    const brief = initiative.handoffBrief;
    const title = initiative.handoffTitle;
    const validTitle = typeof title === "string" && title.trim().length > 0 && title.length <= 160;
    if (!isSparkHandoffBrief(brief) || !validTitle) throw new Error("spark_handoff_brief_unavailable");
    if (!sessions.createAssistantConversation) throw new Error("spark_handoff_unavailable");
    const identity = createHash("sha256").update(initiative.proposalId).digest("hex").slice(0, 32);
    const session = await sessions.createAssistantConversation(`spark-work-${identity}`, { title, content: brief, initiative });
    if (session.kind || session.automationOrigin) throw new Error("spark_handoff_target_conflict");
    notify?.(input.environmentId, ["sessions"]);
    sendJson(input.response, 200, { ok: true, sessionId: session.id });
  } catch (error) {
    const code = handoffFailure(error);
    const failure = failures[code]!;
    sendJson(input.response, failure.status, { ok: false, error: code, message: failure.message });
  }
  return true;
}
