import type { ServerResponse } from "node:http";
import type { WebAgentEnvironment } from "./agents-registry.js";
import type { JsonObject } from "./contracts.js";
import { agentInputBody } from "./agents-input.js";
import { sendJson } from "./http.js";

const fields = ["title", "text", "startAt", "intervalMs", "maxOccurrences", "limits"];
export async function handleAgentScheduleRoute(input: {
  entry: WebAgentEnvironment; agentId: string; method: string;
  segments: readonly string[]; body: JsonObject | null; response: ServerResponse;
}): Promise<void> {
  const { entry, agentId: targetAgentId, segments, method, response } = input;
  const scheduleId = segments[3];
  let result: JsonObject;
  let status = 200;
  if (segments.length === 3 && method === "GET") {
    result = await entry.local({ type: "agents.schedules.list.request", targetAgentId });
  } else if (segments.length === 3 && method === "POST") {
    const { id, ...body } = agentInputBody(input.body, ["id", ...fields]);
    result = await entry.local({ type: "agents.schedules.create.request", targetAgentId, scheduleId: id, ...body });
    status = 201;
  } else if (segments.length === 4 && method === "PATCH") {
    result = await entry.local({ type: "agents.schedules.update.request", targetAgentId, scheduleId,
      ...agentInputBody(input.body, [...fields, "expectedRevision"]) });
  } else if (segments.length === 5 && segments[4] === "cancel" && method === "POST") {
    result = await entry.local({ type: "agents.schedules.cancel.request", targetAgentId, scheduleId,
      ...agentInputBody(input.body, ["expectedRevision"]) });
  } else {
    sendJson(response, 405, { ok: false, error: "method_not_allowed" }); return;
  }
  sendJson(response, status, { ok: true, ...result });
}
