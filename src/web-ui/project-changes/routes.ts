import type { IncomingMessage, ServerResponse } from "node:http";
import { readConversationFileReference, type ConversationFileAccess } from "../local-runtime/conversation-file-access.js";
import { ConversationFileError } from "../local-runtime/conversation-file-format.js";
import { readRecordedProjectChange } from "./recorded-file.js";
import { sendJson } from "../local-runtime/http.js";
import { readProjectChangesIdentifier, type ProjectChangesEnvironments } from "./access.js";
import { ProjectChangesError } from "./contracts.js";
import { ProjectChangesService } from "./service.js";

function isSameOriginProjectRequest(request: IncomingMessage): boolean {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const secure = "encrypted" in request.socket && request.socket.encrypted;
    return new URL(origin).origin === `${secure ? "https" : "http"}://${request.headers.host}`;
  } catch { return false; }
}

export class ProjectChangesRoutes {
  private readonly service: ProjectChangesService;
  constructor(private readonly environments: ProjectChangesEnvironments, private readonly defaultEnvironment: () => string, private readonly fileAccess?: ConversationFileAccess) {
    this.service = new ProjectChangesService(environments, defaultEnvironment);
  }
  async handle(route: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!["chat/project-changes", "chat/project-changes/file", "chat/project-changes/operation"].includes(route)) return false;
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    const abort = new AbortController();
    const cancel = () => abort.abort();
    response.once("close", cancel);
    try {
      if (request.method !== "GET") throw new ProjectChangesError("method_not_allowed", "Project changes support read requests only.", 405);
      if (!isSameOriginProjectRequest(request)) throw new ProjectChangesError("project_changes_request_rejected", "Open project changes from this Web UI.", 403);
      const url = new URL(request.url ?? "/", "http://localhost");
      const allowed = new Set(route === "chat/project-changes/operation"
        ? ["environment", "sessionId", "requestId", "executionId"] : ["environment", "sessionId", "fileId", "revision"]);
      for (const key of url.searchParams.keys()) {
        if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
          throw new ProjectChangesError("project_changes_reference_invalid", "Unsupported changes request.");
      }
      const environment = readProjectChangesIdentifier(url.searchParams.get("environment"));
      const sessionId = readProjectChangesIdentifier(url.searchParams.get("sessionId"));
      if (route === "chat/project-changes/operation") {
        const change = await readRecordedProjectChange(this.environments, this.defaultEnvironment(), this.fileAccess, readConversationFileReference(url), abort.signal);
        sendJson(response, 200, { ok: true, change });
      } else if (route === "chat/project-changes/file") {
        const file = await this.service.file(environment, sessionId, url.searchParams.get("fileId") ?? "", url.searchParams.get("revision") ?? "", abort.signal);
        sendJson(response, 200, { ok: true, file });
      } else {
        const changes = await this.service.list(environment, sessionId, abort.signal);
        sendJson(response, 200, { ok: true, changes });
      }
    } catch (error) {
      const failure = error instanceof ProjectChangesError || error instanceof ConversationFileError ? error
        : new ProjectChangesError("project_changes_unavailable", "Project changes are unavailable.", 503);
      sendJson(response, failure.statusCode, { ok: false, error: failure.code, message: failure.message });
    } finally { response.removeListener("close", cancel); }
    return true;
  }
}
