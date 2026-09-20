import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeProjectService } from "../../runtime/projects/contracts.js";
import type { JsonObject, RuntimeEnvironment } from "./contracts.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { getString, sendJson } from "./http.js";

type ProjectRouteRequest = {
  method: string;
  segments: readonly string[];
  url: URL;
  body: JsonObject | null;
  environment: RuntimeEnvironment;
  request: IncomingMessage;
  response: ServerResponse;
};

function isProjectCollection(segments: readonly string[]): boolean {
  return segments.length === 1;
}
function isProjectFolderListing(segments: readonly string[]): boolean {
  if (segments.length !== 2) return false;
  return segments[1] === "folders";
}
function isProjectSessionCreation(segments: readonly string[]): boolean {
  if (segments.length !== 3) return false;
  return segments[2] === "sessions";
}
function isProjectMutationRequest(method: string): boolean {
  return method === "POST";
}
function acceptProjectRequest(request: ProjectRouteRequest): boolean {
  if (!isProjectMutationRequest(request.method)) return true;
  return acceptConfigMutationRequest(request.request, request.response);
}
function projectErrorStatus(code: string): number {
  if (["project_not_found", "project_directory_unavailable"].includes(code))
    return 404;
  if (code === "project_directory_unreadable") return 403;
  if (code === "project_folder_cursor_stale") return 409;
  if (code === "projects_unavailable") return 503;
  return 400;
}
function sendProjectError(response: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof Error && "code" in error
      ? String(error.code)
      : "project_operation_failed";
  sendJson(response, projectErrorStatus(code), {
    ok: false,
    error: code,
    message,
  });
}

/** Project management is an owner service; these routes only serialize it. */
export class ProjectRoutes {
  async handle(request: ProjectRouteRequest): Promise<boolean> {
    if (request.segments[0] !== "projects") return false;
    if (!acceptProjectRequest(request)) return true;
    try {
      const service = request.environment.services.projects;
      if (!service)
        throw Object.assign(
          new Error("Projects are unavailable on this backend."),
          { code: "projects_unavailable" },
        );
      await this.dispatch(request, service);
    } catch (error) {
      sendProjectError(request.response, error);
    }
    return true;
  }

  private async dispatch(
    request: ProjectRouteRequest,
    service: RuntimeProjectService,
  ): Promise<void> {
    const { method, segments, body, response } = request;
    if (method === "GET" && isProjectCollection(segments)) {
      sendJson(response, 200, { ok: true, projects: await service.list() });
      return;
    }
    if (method === "POST" && isProjectCollection(segments)) {
      const project = await service.create({
        directory: getString(body?.directory),
        name: getString(body?.name),
      });
      sendJson(response, 201, { ok: true, project });
      return;
    }
    if (method === "GET" && isProjectFolderListing(segments)) {
      const page = await service.browseFolders({
        path: getString(request.url.searchParams.get("path")),
        cursor: getString(request.url.searchParams.get("cursor")),
      });
      sendJson(response, 200, { ok: true, ...page });
      return;
    }
    if (method === "POST" && isProjectSessionCreation(segments)) {
      const session = await service.createSession(segments[1]!);
      sendJson(response, 201, { ok: true, ...session });
      return;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  }
}
