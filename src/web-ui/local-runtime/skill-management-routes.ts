import type { IncomingMessage, ServerResponse } from "node:http";
import {
  KnowledgeSkillError,
  PERSONAL_SKILL_LIMITS,
  type PersonalSkillManagementService,
  type PersonalSkillInput,
} from "../../runtime/knowledge-skills/personal-contracts.js";
import type { JsonObject } from "./contracts.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { sendJson } from "./http.js";

type SkillManagementRequest = Readonly<{
  method: string;
  segments: readonly string[];
  body: JsonObject | null;
  environmentId: string;
  request: IncomingMessage;
  response: ServerResponse;
}>;

/** Personal records only; the runtime owner shares the model Store's lock. */
export class PersonalSkillManagementRoutes {
  constructor(private readonly resolveService: (
    environmentId: string,
  ) => PersonalSkillManagementService | undefined) {}

  async handle(request: SkillManagementRequest): Promise<boolean> {
    const { segments, method, response } = request;
    if (segments[0] !== "runtime" || segments[1] !== "skills") return false;
    const isItem = segments.length === 3 && Boolean(segments[2]);
    const isArchiveAction = segments.length === 4 && Boolean(segments[2]) &&
      (segments[3] === "archive" || segments[3] === "restore");
    if (segments.length !== 2 && !isItem && !isArchiveAction) return false;
    const allow = isArchiveAction ? "POST" : isItem ? "GET, PATCH" : "GET, POST";
    if (!allow.split(", ").includes(method)) {
      response.setHeader("allow", allow);
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    if (method !== "GET" && !acceptConfigMutationRequest(request.request, response)) return true;
    try {
      const service = this.resolveService(request.environmentId);
      if (!service) throw new KnowledgeSkillError("knowledge_skill_management_unavailable");
      if (segments.length === 2) {
        if (method === "POST") {
          const skill = await service.create(readCreation(request.body));
          sendJson(response, 201, { ok: true, skill });
        } else {
          sendJson(response, 200, { ok: true, items: await service.list() });
        }
        return true;
      }
      const skillId = segments[2]!;
      let skill;
      if (method === "GET") {
        skill = await service.get(skillId);
        if (!skill) throw new KnowledgeSkillError("knowledge_skill_not_found");
      } else {
        const expectedRevision = readMutation(request.body, method === "PATCH");
        if (method === "PATCH") {
          skill = await service.updateContent(skillId, expectedRevision, request.body!.content as string);
        } else if (segments[3] === "archive") {
          skill = await service.archive(skillId, expectedRevision);
        } else {
          skill = await service.restore(skillId, expectedRevision);
        }
      }
      sendJson(response, 200, { ok: true, skill });
    } catch (error) {
      sendManagementError(response, error);
    }
    return true;
  }
}

function readCreation(body: JsonObject | null): PersonalSkillInput {
  const allowed = ["name", "description", "content", "environment", "environmentId"];
  if (!body || Object.keys(body).some((key) => !allowed.includes(key)) ||
      typeof body.name !== "string" || typeof body.description !== "string" || typeof body.content !== "string") {
    throw new KnowledgeSkillError("knowledge_skill_input_invalid");
  }
  return { name: body.name, description: body.description, content: body.content };
}

function readMutation(body: JsonObject | null, contentRequired: boolean): number {
  const allowed = ["expectedRevision", "environment", "environmentId", ...(contentRequired ? ["content"] : [])];
  if (!body || Object.keys(body).some((key) => !allowed.includes(key)) ||
      (contentRequired && typeof body.content !== "string")) {
    throw new KnowledgeSkillError("knowledge_skill_input_invalid");
  }
  const revision = body.expectedRevision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 ||
      revision > PERSONAL_SKILL_LIMITS.revision) {
    throw new KnowledgeSkillError("knowledge_skill_revision_invalid");
  }
  return revision;
}

const ERROR_STATUSES: Readonly<Record<string, number>> = Object.freeze({
  knowledge_skill_not_found: 404,
  knowledge_skill_read_only: 403,
  knowledge_skill_revision_conflict: 409,
  knowledge_skill_revision_limit: 409,
  knowledge_skill_archived: 409,
  knowledge_skill_input_invalid: 400,
  knowledge_skill_id_invalid: 400,
  knowledge_skill_revision_invalid: 400,
  knowledge_skill_content_invalid: 400,
  knowledge_skill_content_too_large: 400,
  knowledge_skill_name_invalid: 400,
  knowledge_skill_description_invalid: 400,
  knowledge_skill_storage_unavailable: 503,
  knowledge_skill_storage_invalid: 503,
  knowledge_skill_storage_too_large: 503,
  knowledge_skill_management_unavailable: 503,
});

function sendManagementError(response: ServerResponse, error: unknown): void {
  // RPC reconstructs Error with its code; do not rely on prototype identity.
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (typeof code === "string" && Object.hasOwn(ERROR_STATUSES, code)) {
    sendJson(response, ERROR_STATUSES[code]!, { ok: false, error: code });
    return;
  }
  const unavailable = error instanceof Error && error.message === "local_runtime_service_unavailable";
  sendJson(response, unavailable ? 503 : 500, {
    ok: false, error: unavailable ? "knowledge_skill_management_unavailable" : "knowledge_skill_management_failed",
  });
}
