import { readSparkToolPermissionMode } from "../../runtime/passive-learning/spark-chat-preferences.js";
import type { PassiveLearningManagement } from "../../runtime/local-host/client-learning.js";

export async function loadSparkChatConfiguration(learning: Pick<PassiveLearningManagement, "status">) {
  const { preferences } = await learning.status();
  return {
    toolPermissionMode: readSparkToolPermissionMode(preferences.sparkToolPermissionMode),
    modelProfileId: preferences.proactiveModelProfileId ?? preferences.modelProfileId ?? null,
  };
}

export function readSparkChatConfigurationUpdate(body: Record<string, unknown> | null) {
  if (!body || body.toolPermissionMode === undefined) throw new Error("spark_chat_preferences_invalid");
  const allowed = ["environment", "environmentId", "toolPermissionMode"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new Error("spark_chat_preferences_invalid");
  return { sparkToolPermissionMode: readSparkToolPermissionMode(body.toolPermissionMode) };
}
