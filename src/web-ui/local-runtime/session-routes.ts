import type { ServerResponse } from "node:http";
import type { RuntimeEnvironment, JsonObject } from "./contracts.js";
import { deleteSessionWithAttachments } from "../../runtime/session/session-attachment-deletion.js";
import { deleteSessionAttachmentsIfSupported } from "./attachment-routes.js";
import { WebSessionReadStates } from "../session-read-state/service.js";
import { sendJson } from "./http.js";

type SessionRouteRequest = {
  method: string;
  segments: string[];
  body: JsonObject | null;
  environmentId: string;
  environment: RuntimeEnvironment;
  response: ServerResponse;
};

export class WebSessionRoutes {
  constructor(private readonly readStates: WebSessionReadStates) {}

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
    if (!sessionId) return false;
    const sessions = environment.services.sessions;
    if (method === "GET" && action === "messages") {
      const snapshot = await sessions.getSessionSnapshot(sessionId, {
        includeRequests: true,
      });
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
        ...snapshot,
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
      sendJson(response, 200, { ok: true, readState });
      return true;
    }
    if (method === "DELETE" && action === "messages") {
      const result = await sessions.clearSessionMessages(sessionId);
      if (!result) {
        sendJson(response, 404, { ok: false, error: "session_not_found" });
        return true;
      }
      await this.readStates.reset(environmentId, sessionId);
      await deleteSessionAttachmentsIfSupported(environment, sessionId);
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }
    if (method === "DELETE" && !action) {
      const result = await deleteSessionWithAttachments(
        sessions,
        environment.services.attachments,
        sessionId,
      );
      await this.readStates.forget(environmentId, sessionId);
      sendJson(response, 200, { ok: true, ...result });
      return true;
    }
    return false;
  }
}
