import { readSparkToolPermissionMode } from "../../runtime/passive-learning/spark-chat-preferences.js";

export { loadSparkChatConfiguration } from "../../runtime/spark-chat/service.js";

export function readSparkChatConfigurationUpdate(body: Record<string, unknown> | null) {
  if (!body || body.toolPermissionMode === undefined) throw new Error("spark_chat_preferences_invalid");
  const allowed = ["environment", "environmentId", "toolPermissionMode"];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new Error("spark_chat_preferences_invalid");
  return { sparkToolPermissionMode: readSparkToolPermissionMode(body.toolPermissionMode) };
}
