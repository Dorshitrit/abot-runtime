import { isSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import type { RuntimeEnvironment, JsonObject } from "./contracts.js";
import { loadSparkChatConfiguration } from "./spark-chat-configuration.js";

export function publicSparkChatAdmissionFailure(error: unknown) {
  if (error instanceof Error && error.message === "spark_chat_session_unavailable") return {
    error: error.message, message: "The SPARK conversation is unavailable. Open SPARK before sending a message.",
  };
  if (error instanceof Error && error.message === "spark_chat_model_required") return {
    error: error.message, message: "Choose a chat and initiative model in SPARK settings before sending a message.",
  };
  if (error instanceof Error && error.message === "spark_chat_model_unavailable") return {
    error: error.message, message: "The selected SPARK model is unavailable. Choose an available model in SPARK settings.",
  };
  return { error: "spark_chat_unavailable", message: "SPARK chat settings could not be loaded." };
}

/** A marked companion uses the owner's current settings, never a stale tab's defaults. */
export async function resolveSparkChatRequest(
  environment: RuntimeEnvironment, sessionId: string, body: JsonObject,
): Promise<JsonObject> {
  if (sessionId !== SPARK_SESSION_ID) return body;
  const session = await environment.services.sessions.getSessionById(sessionId);
  if (!session) throw new Error("spark_chat_session_unavailable");
  if (!isSparkSession(session)) throw new Error("spark_chat_session_unavailable");
  const settings = await loadSparkChatConfiguration(environment.services.passiveLearning);
  if (!settings.modelProfileId) throw new Error("spark_chat_model_required");
  if (!environment.services.config.models?.profiles?.[settings.modelProfileId])
    throw new Error("spark_chat_model_unavailable");
  return {
    ...body,
    modelPreference: { profileId: settings.modelProfileId, scope: "all" },
    toolPermissionMode: settings.toolPermissionMode,
  };
}
