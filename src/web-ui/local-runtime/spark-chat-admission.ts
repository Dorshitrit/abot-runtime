import { createSparkChatAccess } from "../../runtime/spark-chat/service.js";
import type { RuntimeEnvironment, JsonObject } from "./contracts.js";

export { publicSparkChatAdmissionFailure } from "../../runtime/spark-chat/service.js";

/** A marked companion uses the owner's current settings, never a stale tab's defaults. */
export async function resolveSparkChatRequest(
  environment: RuntimeEnvironment, sessionId: string, body: JsonObject,
): Promise<JsonObject> {
  return createSparkChatAccess(environment.services).resolve(sessionId, body);
}
