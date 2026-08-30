import type { IncomingMessage, ServerResponse } from "node:http";

import type { LongTermMemoryManagementService } from "../../runtime/long-term-memory/contracts.js";
import type { JsonObject } from "./contracts.js";
import { sendJson } from "./http.js";
import {
  readMemoryCreateInput,
  readMemoryPage,
  readMemoryUpdateInput,
} from "./memory-management-input.js";
import {
  projectWebMemoryRecord,
  projectWebMemoryStatus,
  sendMemoryManagementError,
} from "./memory-management-response.js";
import { withHttpRequestAbortSignal } from "./request-abort.js";

type ResolveMemoryManagementService = (
  environmentId: string,
) => LongTermMemoryManagementService;

type MemoryManagementRouteRequest = Readonly<{
  method: string;
  route: string;
  segments: readonly string[];
  url: URL;
  body: JsonObject | null;
  environmentId: string;
  request: IncomingMessage;
  response: ServerResponse;
}>;

const RECORDS_ROUTE = "runtime/memory/records";
const SEARCH_ROUTE = "runtime/memory/records/search";

export class LongTermMemoryManagementRoutes {
  constructor(
    private readonly resolveService: ResolveMemoryManagementService,
  ) {}

  async handle(request: MemoryManagementRouteRequest): Promise<boolean> {
    if (!isMemoryManagementRoute(request)) return false;
    try {
      await this.handleKnownRoute(
        request,
        this.resolveService(request.environmentId),
      );
    } catch (error) {
      sendMemoryManagementError(request.response, error);
    }
    return true;
  }

  private async handleKnownRoute(
    request: MemoryManagementRouteRequest,
    service: LongTermMemoryManagementService,
  ): Promise<void> {
    if (request.route === RECORDS_ROUTE) {
      await this.handleCollection(request, service);
      return;
    }
    if (request.route === SEARCH_ROUTE) {
      await this.handleSearch(request, service);
      return;
    }
    await this.handleRecord(request, service);
  }

  private async handleCollection(
    request: MemoryManagementRouteRequest,
    service: LongTermMemoryManagementService,
  ): Promise<void> {
    if (request.method === "GET") {
      const [status, result] = await Promise.all([
        service.status(),
        service.list(readMemoryPage(request.url)),
      ]);
      sendJson(request.response, 200, {
        ok: true,
        status: projectWebMemoryStatus(status),
        items: result.items.map(projectWebMemoryRecord),
        total: result.total,
      });
      return;
    }
    if (request.method === "POST") {
      const input = readMemoryCreateInput(request.body);
      const result = await withManagementContext(request, (context) =>
        service.create({
          ...input,
          source: "web_ui",
          context,
        }),
      );
      sendJson(request.response, 201, {
        ok: true,
        record: projectWebMemoryRecord(result.record),
      });
      return;
    }
    sendMethodNotAllowed(request.response, "GET, POST");
  }

  private async handleSearch(
    request: MemoryManagementRouteRequest,
    service: LongTermMemoryManagementService,
  ): Promise<void> {
    if (request.method !== "GET") {
      sendMethodNotAllowed(request.response, "GET");
      return;
    }
    const result = await withManagementContext(request, (context) =>
      service.search({
        query: request.url.searchParams.get("q") ?? "",
        ...readMemoryPage(request.url),
        context,
      }),
    );
    sendJson(request.response, 200, {
      ok: true,
      items: result.items.map(projectWebMemoryRecord),
      total: result.total,
    });
  }

  private async handleRecord(
    request: MemoryManagementRouteRequest,
    service: LongTermMemoryManagementService,
  ): Promise<void> {
    const id = request.segments[3] ?? "";
    if (request.method === "PATCH") {
      const input = readMemoryUpdateInput(request.body);
      const result = await withManagementContext(request, (context) =>
        service.update({ id, ...input, context }),
      );
      sendJson(request.response, 200, {
        ok: true,
        record: projectWebMemoryRecord(result.record),
        updated: result.updated,
      });
      return;
    }
    if (request.method === "DELETE") {
      const result = await service.delete({ id });
      if (!result.deleted) {
        sendJson(request.response, 404, {
          ok: false,
          error: "long_term_memory_management_not_found",
          memoryId: id,
        });
        return;
      }
      sendJson(request.response, 200, { ok: true, deleted: true });
      return;
    }
    sendMethodNotAllowed(request.response, "PATCH, DELETE");
  }
}

function isMemoryManagementRoute(
  request: MemoryManagementRouteRequest,
): boolean {
  if (request.route === RECORDS_ROUTE || request.route === SEARCH_ROUTE) {
    return true;
  }
  return (
    request.segments.length === 4 &&
    request.segments[0] === "runtime" &&
    request.segments[1] === "memory" &&
    request.segments[2] === "records" &&
    Boolean(request.segments[3])
  );
}

function withManagementContext<T>(
  request: MemoryManagementRouteRequest,
  run: (context: Readonly<{ abortSignal: AbortSignal }>) => Promise<T>,
): Promise<T> {
  return withHttpRequestAbortSignal({
    request: request.request,
    response: request.response,
    reason: "memory_management_request_aborted",
    run: (abortSignal) => run(Object.freeze({ abortSignal })),
  });
}

function sendMethodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("allow", allow);
  sendJson(response, 405, { ok: false, error: "method_not_allowed" });
}
