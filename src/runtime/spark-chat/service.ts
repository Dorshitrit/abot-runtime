import {
  ensureSparkSession,
  isSparkSession,
  SPARK_SESSION_ID,
} from "../../sessions/spark-session.js";
import type { SessionRecord } from "../../sessions/types.js";
import { readSparkToolPermissionMode } from "../passive-learning/spark-chat-preferences.js";
import type {
  SparkChatAccess,
  SparkChatServices,
  SparkChatState,
} from "./contracts.js";

const SPARK_CHAT_FAILURE_MESSAGES = {
  spark_chat_session_unavailable: "The SPARK conversation is unavailable. Open SPARK before sending a message.",
  spark_chat_model_required: "Choose a chat and initiative model in SPARK settings before sending a message.",
  spark_chat_model_unavailable: "The selected SPARK model is unavailable. Choose an available model in SPARK settings.",
  spark_chat_permission_mismatch: "SPARK permissions changed or are not permitted for this connection. Reopen SPARK before sending a message.",
  spark_chat_unsupported: "This runtime connection does not support SPARK chat.",
  spark_chat_unavailable: "SPARK chat settings could not be loaded.",
} as const;

export function getSparkChatAdmissionErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!Object.hasOwn(SPARK_CHAT_FAILURE_MESSAGES, error.message)) return undefined;
  return error.message;
}

export function publicSparkChatAdmissionFailure(error: unknown) {
  const code = getSparkChatAdmissionErrorCode(error) ?? "spark_chat_unavailable";
  return {
    error: code,
    message: SPARK_CHAT_FAILURE_MESSAGES[code as keyof typeof SPARK_CHAT_FAILURE_MESSAGES],
  };
}

export async function loadSparkChatConfiguration(
  learning: SparkChatServices["passiveLearning"],
): Promise<Pick<SparkChatState, "modelProfileId" | "toolPermissionMode">> {
  const { preferences } = await learning.status();
  return {
    toolPermissionMode: readSparkToolPermissionMode(preferences.sparkToolPermissionMode),
    modelProfileId: preferences.proactiveModelProfileId ?? preferences.modelProfileId ?? null,
  };
}

function assertSparkSessionKind(session: SessionRecord | null | undefined): asserts session is SessionRecord {
  if (!session) throw new Error("spark_chat_session_unavailable");
  if (!isSparkSession(session)) throw new Error("spark_chat_session_unavailable");
}

/** Opening may create the reserved session, but never reclassifies an existing one. */
export async function ensureSparkChatSession(sessions: SparkChatServices["sessions"]): Promise<SessionRecord> {
  const existing = await sessions.getSessionById(SPARK_SESSION_ID);
  if (existing) {
    assertSparkSessionKind(existing);
    return existing;
  }
  try {
    const session = await ensureSparkSession(sessions);
    assertSparkSessionKind(session);
    return session;
  } catch (error) {
    if (error instanceof Error && error.message === "session_kind_binding_immutable") {
      throw new Error("spark_chat_session_unavailable");
    }
    throw error;
  }
}

function readSparkModelReadiness(
  config: SparkChatServices["config"],
  modelProfileId: string | null,
): SparkChatState["readiness"] {
  if (!modelProfileId) return "model_required";
  if (!config.models?.profiles?.[modelProfileId]) return "model_unavailable";
  return "ready";
}

async function readSparkChatState(services: SparkChatServices): Promise<SparkChatState> {
  const settings = await loadSparkChatConfiguration(services.passiveLearning);
  return {
    sessionId: SPARK_SESSION_ID,
    ...settings,
    readiness: readSparkModelReadiness(services.config, settings.modelProfileId),
  };
}

function assertSparkModelReady(state: SparkChatState): void {
  if (state.readiness === "model_required") throw new Error("spark_chat_model_required");
  if (state.readiness === "model_unavailable") throw new Error("spark_chat_model_unavailable");
}

function assertMatchingSparkPermissionMode(body: object, state: SparkChatState): void {
  if (!Object.hasOwn(body, "toolPermissionMode")) throw new Error("spark_chat_permission_mismatch");
  const suppliedMode = (body as Record<string, unknown>).toolPermissionMode;
  if (suppliedMode !== state.toolPermissionMode) throw new Error("spark_chat_permission_mismatch");
}

async function withSparkChatAdmissionFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(getSparkChatAdmissionErrorCode(error) ?? "spark_chat_unavailable");
  }
}

/** Shared admission policy; transports cannot choose the SPARK model or widen its authority. */
export function createSparkChatAccess(services: SparkChatServices): SparkChatAccess {
  return Object.freeze({
    async open() {
      return withSparkChatAdmissionFailure(async () => {
        await ensureSparkChatSession(services.sessions);
        return readSparkChatState(services);
      });
    },
    async resolve<T extends object>(
      sessionId: string,
      body: T,
      options: Readonly<{ requireMatchingPermissionMode?: boolean }> = {},
    ): Promise<T> {
      if (sessionId !== SPARK_SESSION_ID) return body;
      return withSparkChatAdmissionFailure(async () => {
        assertSparkSessionKind(await services.sessions.getSessionById(sessionId));
        const state = await readSparkChatState(services);
        assertSparkModelReady(state);
        if (options.requireMatchingPermissionMode) assertMatchingSparkPermissionMode(body, state);
        return {
          ...body,
          modelPreference: { profileId: state.modelProfileId, scope: "all" },
          toolPermissionMode: state.toolPermissionMode,
        };
      });
    },
  });
}
