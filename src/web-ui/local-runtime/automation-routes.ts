import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AutomationService } from "../../runtime/automations/service.js";
import type { OperationRef } from "../../runtime/automations/definition-contracts.js";
import { AutomationPublicationError } from "../../runtime/automations/publication.js";
import type { JsonObject } from "./contracts.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";
import { readAutomationRunPage } from "./automation-run-page.js";

type AutomationEnvironment = {
  start(): Promise<void>;
  services: { automations?: AutomationService };
};

type AutomationRouteRequest = {
  method: string;
  segments: readonly string[];
  url: URL;
  body: JsonObject | null;
  environmentId: string;
  request: IncomingMessage;
  response: ServerResponse;
};

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error("automation_revision_required");
  return Number(value);
}

function optionalGrantRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error("automation_grant_revision_required");
  return Number(value);
}

function requiredIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128)
    throw new Error("automation_idempotency_key_required");
  return value;
}

function operationRefs(value: unknown): OperationRef[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("automation_grant_invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("automation_grant_invalid");
    const operation = item as Record<string, unknown>;
    if (typeof operation.toolName !== "string" ||
        typeof operation.operationId !== "string" ||
        !Number.isSafeInteger(operation.contractVersion))
      throw new Error("automation_grant_invalid");
    return {
      toolName: operation.toolName,
      operationId: operation.operationId,
      contractVersion: Number(operation.contractVersion),
    };
  });
}

function sendAutomationError(response: ServerResponse, error: unknown): void {
  if (error instanceof AutomationPublicationError) {
    sendJson(response, 422, {
      ok: false, error: "automation_graph_invalid", issues: error.issues,
    });
    return;
  }
  const code = error instanceof Error ? error.message : "automation_request_failed";
  const status = code.includes("not_found") ? 404 :
    code.includes("revision_conflict") ? 409 :
    code === "automation_draft_published" || code === "automation_archived" ||
      code === "automation_run_active" || code === "automation_not_published" ? 409 :
    code.includes("unavailable") || code.includes("locked") ? 409 :
    code === "automation_revision_required" ? 428 : 400;
  sendJson(response, status, { ok: false, error: code, message: code });
}

export class AutomationRoutes {
  constructor(private readonly resolveEnvironment: (id: string) => AutomationEnvironment) {}

  async handle(request: AutomationRouteRequest): Promise<boolean> {
    if (request.segments[0] !== "automations" &&
        request.segments[0] !== "automation-runs") return false;
    if (request.method !== "GET" && request.method !== "HEAD" &&
        !acceptConfigMutationRequest(request.request, request.response)) return true;
    try {
      const environment = this.resolveEnvironment(request.environmentId);
      await environment.start();
      const service = environment.services.automations;
      if (!service) throw new Error("automation_unavailable");
      if (request.segments[0] === "automations")
        await this.handleDefinition(request, service);
      else
        await this.handleRun(request, service);
    } catch (error) {
      sendAutomationError(request.response, error);
    }
    return true;
  }

  private async handleDefinition(request: AutomationRouteRequest, service: AutomationService): Promise<void> {
    const { method, segments, body, response } = request;
    const [, automationId, action] = segments;
    if (segments.length === 1) {
      if (method === "GET") sendJson(response, 200, { ok: true, automations: await service.list() });
      else if (method === "POST") {
        const title = typeof body?.title === "string" ? body.title : "ABot Automation";
        if (body?.templateId !== undefined && typeof body.templateId !== "string")
          throw new Error("automation_template_unavailable");
        sendJson(response, 201, { ok: true, draft: await service.create(title, body?.templateId) });
      } else this.methodNotAllowed(response, "GET, POST");
      return;
    }
    if (automationId === "catalog" && segments.length === 2 && method === "GET") {
      const selectedId = request.url.searchParams.get("automation") ?? "";
      sendJson(response, 200, { ok: true, ...await service.catalog(selectedId) });
      return;
    }
    if (!automationId || segments.length > 3) {
      sendJson(response, 404, { ok: false, error: "not_found" });
      return;
    }
    if (action === "draft") {
      if (method === "GET") {
        const draft = await service.getDraft(automationId);
        if (!draft) throw new Error("automation_not_found");
        sendJson(response, 200, {
          ok: true, draft, grant: await service.getGrant(automationId),
          validation: await service.validate(automationId),
          publishedDefinition: await service.getPublishedDefinition(automationId),
        });
      } else if (method === "PATCH") {
        sendJson(response, 200, { ok: true,
          draft: await service.updateDraft(automationId,
            requiredRevision(body?.expectedRevision), body?.mutation),
        });
      } else if (method === "DELETE") {
        await service.deleteDraft(automationId, requiredRevision(body?.expectedRevision));
        sendJson(response, 200, { ok: true });
      } else this.methodNotAllowed(response, "GET, PATCH, DELETE");
      return;
    }
    if (action === "agents" && method === "POST") {
      sendJson(response, 201, { ok: true,
        agent: await service.saveAgentFromDraft({
          automationId,
          nodeId: typeof body?.nodeId === "string" ? body.nodeId : "",
          expectedDraftRevision: requiredRevision(body?.expectedRevision),
        }),
      });
      return;
    }
    if (action === "validate" && method === "POST") {
      sendJson(response, 200, { ok: true, issues: await service.validate(automationId) });
      return;
    }
    if (action === "permission" && method === "PUT") {
      const mode = body?.mode;
      if (mode !== "full_access" && mode !== "full_plus")
        throw new Error("automation_grant_invalid");
      sendJson(response, 200, { ok: true, grant: await service.replaceGrant({
        automationId,
        expectedGrantRevision: optionalGrantRevision(body?.expectedGrantRevision),
        mode,
        operations: operationRefs(body?.operations),
        actionId: randomUUID(),
      }) });
      return;
    }
    if (action === "publish" && method === "POST") {
      const published = await service.publish(automationId, requiredRevision(body?.expectedRevision));
      sendJson(response, 200, { ok: true, ...published });
      return;
    }
    if ((action === "archive" || action === "restore") && method === "POST") {
      sendJson(response, 200, { ok: true,
        draft: await service[action](automationId, requiredRevision(body?.expectedRevision)),
      });
      return;
    }
    if (action === "activate" && method === "POST") {
      sendJson(response, 200, { ok: true, job: await service.activate(automationId) });
      return;
    }
    if (action === "pause" && method === "POST") {
      sendJson(response, 200, { ok: true, job: await service.pause(automationId) });
      return;
    }
    if (action === "run" && method === "POST") {
      sendJson(response, 200, { ok: true,
        run: await service.runNow(automationId, requiredIdempotencyKey(body?.idempotencyKey)),
      });
      return;
    }
    if (action === "runs" && method === "GET") {
      sendJson(response, 200, { ok: true,
        ...await readAutomationRunPage(service, automationId, request.url.searchParams),
      });
      return;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  }

  private async handleRun(request: AutomationRouteRequest, service: AutomationService): Promise<void> {
    const { method, segments, response } = request;
    const [, runId, action, nodeId] = segments;
    if (!runId || segments.length > 4) {
      sendJson(response, 404, { ok: false, error: "not_found" });
      return;
    }
    if (!action && segments.length === 2 && method === "GET") {
      response.setHeader("cache-control", "private, no-store");
      sendJson(response, 200, { ok: true, run: await service.getRun(runId) });
      return;
    }
    if (action === "steps" && nodeId && segments.length === 4 && method === "GET") {
      response.setHeader("cache-control", "private, no-store");
      sendJson(response, 200, { ok: true, evidence: await service.getStepEvidence(
        runId, nodeId, request.url.searchParams.get("full") === "1",
      ) });
      return;
    }
    if (action === "stop" && segments.length === 3 && method === "POST") {
      await service.stopRun(runId);
      sendJson(response, 200, { ok: true, run: await service.getRun(runId) });
      return;
    }
    if (action === "rerun" && segments.length === 3 && method === "POST") {
      if (request.body?.confirmed !== true)
        throw new Error("automation_rerun_confirmation_required");
      sendJson(response, 200, { ok: true,
        run: await service.rerun(runId,
          requiredIdempotencyKey(request.body.idempotencyKey), true),
      });
      return;
    }
    sendJson(response, 404, { ok: false, error: "not_found" });
  }

  private methodNotAllowed(response: ServerResponse, allow: string): void {
    response.setHeader("allow", allow);
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
  }
}
