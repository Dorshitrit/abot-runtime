import type { IncomingMessage, ServerResponse } from "node:http";
import { agentReplyId, type AgentNotificationInbox } from "./agent-chat-notifications.js";
import { handleAgentScheduleRoute } from "./agent-schedule-routes.js";
import { acceptConfigMutationRequest } from "./config-mutation-request.js";
import { agentInputBody, agentInputText } from "./agents-input.js";
import { WebAgentRegistry } from "./agents-registry.js";
import type { JsonObject, RuntimeEnvironment } from "./contracts.js";
import { sendJson } from "./http.js";

type AgentRouteRequest = { method: string; segments: readonly string[]; body: JsonObject | null;
  environmentId: string; request: IncomingMessage; response: ServerResponse };
const definitionFields = ["definition", "limits", "onboarding", "expectedRevision", "authoring"];
const commands: Record<string, { type: string; fields: string[]; status: number }> = {
  messages: { type: "agents.message.send.request", fields: ["text", "clientMessageId", "intent", "limits"], status: 202 },
  actions: { type: "agents.action.request", fields: ["action", "expectedRevision", "text", "limits"], status: 200 },
  approval: { type: "agents.approval.decide.request",
    fields: ["approvalId", "approved", "reason", "generation", "waitId", "revision", "commandId"], status: 200 },
};
function routeError(error: unknown): { status: number; error: string } {
  const message = error instanceof Error ? error.message : "";
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : message;
  if (!/^(agents_|agent_|approval_)[a-z0-9_]+$/.test(code)) return { status: 503, error: "agents_service_unavailable" };
  if (code === "agents_deletion_cleanup_failed") return { status: 503, error: code };
  if (code.includes("not_found")) return { status: 404, error: code };
  if (code.includes("input") || code.includes("invalid") || code.includes("required")) return { status: 400, error: code };
  return { status: 409, error: code };
}

/** HTTP owns origin validation and the browser inbox. Agent commands execute at the runtime owner. */
export class WebAgentRoutes {
  readonly registry: WebAgentRegistry;
  constructor(environment: (id: string) => RuntimeEnvironment, private readonly inbox?: AgentNotificationInbox,
    forgetSession?: (environment: string, sessionId: string) => Promise<void>,
    forgetDrafts?: (environment: string, agentId: string) => Promise<void>) {
    this.registry = new WebAgentRegistry(environment, inbox, forgetSession, forgetDrafts);
  }
  async handle(input: AgentRouteRequest): Promise<boolean> {
    if (input.segments[0] !== "agents") return false;
    const { method, response, segments, environmentId } = input;
    response.setHeader("cache-control", "no-store");
    if (method !== "GET" && !acceptConfigMutationRequest(input.request, response)) return true;
    try {
      const entry = await this.registry.get(environmentId);
      const id = segments[1], action = segments[2];
      const reply = (data: JsonObject, status = 200) => sendJson(response, status, { ok: true, ...data });
      if (!id && segments.length === 1 && method === "GET") {
        const catalog = await entry.local({ type: "agents.list.request" });
        const unread = await this.inbox?.unreadAgentReplies(environmentId) ?? [];
        const previews = new Map<string, { id: string; missionId: string; createdAt: string; text: string }>();
        for (const notice of unread.sort((a, b) => a.createdAt - b.createdAt)) {
          if (notice.kind === "approval" || notice.agentSource.messageId.startsWith("attention:")) continue;
          const source = notice.agentSource;
          previews.set(source.agentId, { id: source.messageId, missionId: source.missionId, createdAt: new Date(notice.createdAt).toISOString(), text: notice.body });
        }
        const agents = (catalog.agents as { id: string }[]).map(agent => ({ ...agent, latestUnreadReply: previews.get(agent.id) ?? null }));
        reply({ agents, revision: catalog.revision });
      } else if (!id && segments.length === 1 && method === "POST") {
        reply(await entry.local({ type: "agents.create.request", ...agentInputBody(input.body, definitionFields) }), 201);
      } else if (id === "authoring" && action === "preview" && segments.length === 3 && method === "POST") {
        reply(await entry.local({ type: "agents.authoring.preview.request", ...agentInputBody(input.body, ["authoring", "targetAgentId"]) }));
      } else if (!id) {
        throw new Error("agents_input_route");
      } else if (!action && segments.length === 2 && method === "GET") {
        reply(await entry.local({ type: "agents.detail.request", targetAgentId: id }));
      } else if (!action && segments.length === 2 && method === "DELETE") {
        await entry.local({ type: "agents.delete.request", targetAgentId: id, ...agentInputBody(input.body, ["expectedRevision"]) });
        await entry.sync();
        reply({});
      } else if (!action && segments.length === 2 && method === "PATCH") {
        reply(await entry.local({ type: "agents.update.request", targetAgentId: id, ...agentInputBody(input.body, definitionFields) }));
      } else if (action === "read" && segments.length === 3 && method === "POST") {
        const body = agentInputBody(input.body, ["through"]);
        const ids = await entry.projection.through(id, agentInputText(body.through, 512, "message_id"));
        await this.inbox?.readAgentReplies(environmentId, ids.map(messageId => agentReplyId(environmentId, id, messageId)));
        reply({});
      } else if (action === "schedules") {
        await handleAgentScheduleRoute({ entry, agentId: id, method, segments, body: input.body, response });
      } else if (action === "sessions" && segments.length === 4 && method === "GET") {
        reply(await entry.local({ type: "agents.session.request", targetAgentId: id, sessionId: segments[3] }));
      } else if (segments.length !== 3 || method !== "POST") {
        sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      } else if (action && Object.hasOwn(commands, action)) {
        const command = commands[action]!;
        reply(await entry.local({ type: command.type, targetAgentId: id, ...agentInputBody(input.body, command.fields) }), command.status);
      } else {
        sendJson(response, 404, { ok: false, error: "agents_route_not_found" });
      }
    } catch (error) { const failure = routeError(error); sendJson(response, failure.status, { ok: false, error: failure.error }); }
    return true;
  }
}
