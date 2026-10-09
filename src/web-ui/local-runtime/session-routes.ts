import { historyPageOptions, publicHistorySnapshot } from "./history-pagination.js";
import type { ServerResponse } from "node:http";
import type { RuntimeEnvironment, JsonObject } from "./contracts.js";
import { deleteSessionWithAttachments } from "../../runtime/session/session-attachment-deletion.js";
import { deleteSessionAttachmentsIfSupported } from "./attachment-routes.js";
import { WebSessionReadStates } from "../session-read-state/service.js";
import { sendJson } from "./http.js";
import type { WorkspaceChangeNotifier } from "./workspace-notifications.js";
import { isSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";

type SessionRouteRequest = {
  url?: URL;
  method: string;
  segments: string[];
  body: JsonObject | null;
  environmentId: string;
  environment: RuntimeEnvironment;
  response: ServerResponse;
};

async function isProtectedSparkSession(environment: RuntimeEnvironment, sessionId: string): Promise<boolean> {
  if (sessionId !== SPARK_SESSION_ID) return false;
  const session = await environment.services.sessions.getSessionById(sessionId);
  if (!session) return false;
  return isSparkSession(session);
}

function isSparkChatBusy(error: unknown): boolean {
  return error instanceof Error && error.message === "spark_chat_busy";
}

export class WebSessionRoutes {
  constructor(
    private readonly readStates: WebSessionReadStates,
    private readonly notifyChanged?: WorkspaceChangeNotifier,
  ) {}

  async handle(request: SessionRouteRequest): Promise<boolean> {
    const { method, segments, body, environmentId, environment, response } =
      request;
    if (segments[0] !== "chat" || segments[1] !== "sessions") return false;
    const [, , sessionId, action] = segments;
    if (segments.length > 4) return false;
    if (method === "GET" && segments.length === 2) {
      sendJson(response, 200, {
        ok: true,
        ...(await this.readStates.list(environmentId)),
      });
      return true;
    }
    if (method === "POST" && sessionId === "page" && !action) {
      sendJson(response, 200, { ok: true, ...(await this.readStates.list(environmentId, body ?? {})) });
      return true;
    }
    if (!sessionId) return false;
    const sessions = environment.services.sessions;
    if (method === "GET" && action === "messages") {
      let snapshot;
      try { snapshot = await sessions.getSessionSnapshot(sessionId, historyPageOptions(request.url, environment.services.config)); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "history_cursor_stale") throw error;
        sendJson(response, 409, { ok: false, error: error.message });
        return true;
      }
      if (!snapshot) {
        sendJson(response, 404, {
          ok: false,
          error: "session_not_found",
          messages: [],
          requests: [],
        });
        return true;
      }
      sendJson(response, 200, {
        ok: true,
        ...publicHistorySnapshot(snapshot),
        readState: await this.readStates.project(environmentId, snapshot),
      });
      return true;
    }
    if (method === "POST" && action === "read") {
      const readState = await this.readStates.mark(
        environmentId,
        sessionId,
        body ?? {},
      );
      if (!readState) {
        sendJson(response, 404, { ok: false, error: "session_not_found" });
        return true;
      }
      this.notifyChanged?.(environmentId, ["sessions"]);
      sendJson(response, 200, { ok: true, readState });
      return true;
    }
    if (method === "DELETE" && action === "messages") {
      const protectedSpark = await isProtectedSparkSession(environment, sessionId);
      let result;
      try {
        result = await sessions.clearSessionMessages(sessionId);
      } catch (error) {
        if (!isSparkChatBusy(error)) throw error;
        sendJson(response, 409, {
          ok: false, error: "spark_chat_busy",
          message: "Stop the active request or resolve its approval before clearing SPARK chat.",
        });
        return true;
      }
      if (!result) {
        sendJson(response, 404, { ok: false, error: "session_not_found" });
        return true;
      }
      try {
        await this.readStates.reset(environmentId, sessionId);
        if (!protectedSpark) await deleteSessionAttachmentsIfSupported(environment, sessionId);
      } finally {
        this.notifyChanged?.(environmentId, ["sessions"]);
      }
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }
    if (method === "DELETE" && !action) {
      if (await isProtectedSparkSession(environment, sessionId)) {
        sendJson(response, 409, { ok: false, error: "spark_session_requires_clear" });
        return true;
      }
      try {
        const result = await deleteSessionWithAttachments(
          sessions,
          environment.services.attachments,
          sessionId,
        );
        await this.readStates.forget(environmentId, sessionId);
        sendJson(response, 200, { ok: true, ...result });
      } finally {
        // Cleanup can reject after deletion commits. Request a reread, not a success claim.
        this.notifyChanged?.(environmentId, ["sessions"]);
      }
      return true;
    }
    return false;
  }
}
