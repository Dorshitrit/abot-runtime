import { historyPageOptions, publicHistorySnapshot } from "./history-pagination.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ensureSparkSession } from "../../sessions/spark-session.js";
import type { RuntimeEnvironment, JsonObject } from "./contracts.js";
import type { WebSessionReadStates } from "../session-read-state/service.js";
import type { WorkspaceChangeNotifier } from "./workspace-notifications.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { loadSparkChatConfiguration, readSparkChatConfigurationUpdate } from "./spark-chat-configuration.js";
import { sendJson } from "./http.js";
import { handleSparkChatHandoff } from "./spark-chat-handoff.js";

export type SparkChatRouteRequest = {
  method: string; route: string; body: JsonObject | null; environmentId: string;
  request: IncomingMessage; response: ServerResponse;
};

export class SparkChatRoutes {
  constructor(
    private readonly environment: (id: string) => RuntimeEnvironment,
    private readonly reads: WebSessionReadStates,
    private readonly notify?: WorkspaceChangeNotifier,
    private readonly onRead?: (environmentId: string, sessionId: string) => void,
  ) {}

  async handle(input: SparkChatRouteRequest): Promise<boolean> {
    if (await handleSparkChatHandoff(input, this.environment, this.notify)) return true;
    if (!["runtime/spark/chat", "runtime/spark/chat/read"].includes(input.route)) return false;
    input.response.setHeader("cache-control", "no-store");
    const readReceipt = input.route.endsWith("/read");
    const allowed = readReceipt ? ["POST"] : ["GET", "PUT"];
    if (!allowed.includes(input.method)) {
      input.response.setHeader("allow", allowed.join(", "));
      sendJson(input.response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    if (input.method !== "GET" && !acceptConfigMutationRequest(input.request, input.response)) return true;
    try {
      const update = input.method === "PUT" ? readSparkChatConfigurationUpdate(input.body) : undefined;
      const environment = this.environment(input.environmentId);
      const session = await ensureSparkSession(environment.services.sessions);
      if (readReceipt) {
        const readState = await this.reads.markVisible(input.environmentId, session.id, input.body?.visibleMessageIds, input.body?.readGeneration, input.body?.visibleMessages);
        if (readState) this.onRead?.(input.environmentId, session.id);
        this.notify?.(input.environmentId, ["sessions"]);
        sendJson(input.response, 200, { ok: true, readState });
        return true;
      }
      if (update) await environment.services.passiveLearning.configure(update);
      const configuration = await loadSparkChatConfiguration(environment.services.passiveLearning);
      const snapshot = await environment.services.sessions.getSessionSnapshot(session.id, historyPageOptions(new URL(input.request.url ?? "/", "http://localhost"), environment.services.config));
      if (!snapshot) throw new Error("spark_chat_unavailable");
      sendJson(input.response, 200, {
        ok: true, sessionId: session.id, ...configuration, snapshot: publicHistorySnapshot(snapshot),
        readState: await this.reads.project(input.environmentId, snapshot),
      });
      return true;
    } catch (error) {
      const code = error instanceof Error ? error.message : "spark_chat_unavailable";
      const invalid = ["spark_chat_preferences_invalid", "invalid_spark_tool_permission_mode", "visible_message_ids_invalid", "visible_message_receipts_invalid"].includes(code);
      const stale = ["read_generation_changed", "visible_message_receipt_stale", "history_cursor_stale"].includes(code);
      sendJson(input.response, invalid ? 400 : 409, {
        ok: false, error: invalid || stale ? code : "spark_chat_unavailable",
      });
      return true;
    }
  }
}
