import { readAgentAuthoringMutation } from "./authoring.js";
import type { ToolPermissionMode } from "../../capabilities/tool-permission-mode.js";
import type { AgentDefinitionInput } from "./management-contracts.js";
import { readAgentMissionLimits } from "./record-validation.js";

export const AGENTS_REMOTE_FEATURE = "agents_v1";
export const AGENT_REMOTE_RESPONSE_BYTES = 1024 * 1024;
export const AGENT_REMOTE_READS: ReadonlySet<string> = new Set(["agents.list.request", "agents.detail.request",
  "agents.sessions.request", "agents.session.request", "agents.schedules.list.request", "agents.authoring.preview.request"]);
export type RemoteAgentCommand = Record<string, unknown> & { type: string; local?: boolean; allowedModes: ToolPermissionMode[] };
const PAGE_FIELDS = ["limit", "cursor"];
const DEFINITION_FIELDS = ["definition", "limits", "onboarding", "expectedRevision", "authoring"];
const SCHEDULE_FIELDS = ["scheduleId", "title", "text", "startAt", "intervalMs", "maxOccurrences", "limits"];
export const AGENT_REMOTE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "agents.list.request": PAGE_FIELDS,
  "agents.authoring.preview.request": ["authoring", "targetAgentId"],
  "agents.detail.request": ["targetAgentId", "limit", "beforeMessageId"],
  "agents.message.send.request": ["targetAgentId", "clientMessageId", "text", "intent", "limits"],
  "agents.action.request": ["targetAgentId", "action", "text", "limits", "expectedRevision"],
  "agents.approval.decide.request": ["targetAgentId", "approvalId", "approved", "reason", "generation", "waitId", "revision", "commandId"],
  "agents.create.request": DEFINITION_FIELDS,
  "agents.update.request": ["targetAgentId", ...DEFINITION_FIELDS],
  "agents.delete.request": ["targetAgentId", "expectedRevision"],
  "agents.sessions.request": ["targetAgentId", ...PAGE_FIELDS],
  "agents.session.request": ["targetAgentId", "sessionId", ...PAGE_FIELDS],
  "agents.schedules.list.request": ["targetAgentId", ...PAGE_FIELDS],
  "agents.schedules.create.request": ["targetAgentId", ...SCHEDULE_FIELDS],
  "agents.schedules.update.request": ["targetAgentId", ...SCHEDULE_FIELDS, "expectedRevision"],
  "agents.schedules.cancel.request": ["targetAgentId", "scheduleId", "expectedRevision"],
};
const MODES: readonly ToolPermissionMode[] = ["ask", "full_access", "full_plus"];

export function remoteAgentText(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`agents_input_${field}`);
  return value;
}
export function remoteAgentRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("agents_input_revision");
  return value as number;
}
export function readRemoteAgentCommand(value: Record<string, unknown>, local = false): RemoteAgentCommand {
  const type = remoteAgentText(value.type, 80, "command");
  if (!Object.hasOwn(AGENT_REMOTE_FIELDS, type)) throw new Error("agents_input_command");
  const allowed = ["type", "allowedModes", ...AGENT_REMOTE_FIELDS[type]!];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("agents_input_fields");
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new Error("agents_input_too_large");
  if (local && Object.hasOwn(value, "allowedModes")) throw new Error("agents_input_fields");
  const modes = local ? [...MODES] : value.allowedModes;
  if (!Array.isArray(modes) || modes.length < 1 || modes.length > 3 || modes.some(mode => !MODES.includes(mode)))
    throw new Error("agents_permission_required");
  if (Object.hasOwn(value, "targetAgentId")) remoteAgentText(value.targetAgentId, local ? 256 : 128, "agent_id");
  return { ...value, type, allowedModes: modes, local };
}

/** Delegation may narrow authority. The grant must cover that entire downward range. */
export function remoteAgentModeAllowed(mode: ToolPermissionMode, allowed: readonly ToolPermissionMode[]): boolean {
  const rank = MODES.indexOf(mode);
  return rank >= 0 && MODES.slice(0, rank + 1).every(candidate => allowed.includes(candidate));
}
export function requireRemoteAgentMode(mode: ToolPermissionMode, allowed: readonly ToolPermissionMode[]): void {
  if (!remoteAgentModeAllowed(mode, allowed)) throw new Error("agents_permission_denied");
}
export function readRemoteAgentDefinition(command: RemoteAgentCommand): AgentDefinitionInput | ReturnType<typeof readAgentAuthoringMutation> {
  if (Object.hasOwn(command, "authoring")) {
    const input = readAgentAuthoringMutation(command);
    requireRemoteAgentMode(input.authoring.toolPermissionMode, command.allowedModes);
    return input;
  }
  const value = command.definition;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agents_input_definition");
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !["name", "icon", "basePrompt", "modelProfileId", "toolPermissionMode"].includes(key)))
    throw new Error("agents_input_definition");
  if (!MODES.includes(fields.toolPermissionMode as ToolPermissionMode)) throw new Error("agents_input_permission");
  requireRemoteAgentMode(fields.toolPermissionMode as ToolPermissionMode, command.allowedModes);
  return {
    name: remoteAgentText(fields.name, 80, "name"), icon: remoteAgentText(fields.icon, 80, "icon"),
    basePrompt: remoteAgentText(fields.basePrompt, 16_000, "base_prompt"),
    modelProfileId: remoteAgentText(fields.modelProfileId, 256, "model"),
    toolPermissionMode: fields.toolPermissionMode as ToolPermissionMode,
    defaultLimits: readAgentMissionLimits(command.limits),
    ...(command.onboarding !== undefined ? { onboarding: command.onboarding as AgentDefinitionInput["onboarding"] } : {}),
  };
}
export function remoteAgentPage<T>(items: readonly T[], command: Record<string, unknown>, identify: (item: T) => string) {
  const limit = command.limit === undefined ? 50 : command.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) throw new Error("agents_input_limit");
  const cursor = command.cursor;
  const index = cursor == null ? -1 : items.findIndex(item => identify(item) === cursor);
  if (cursor != null && index < 0) throw new Error("agents_input_cursor");
  const page = items.slice(index + 1, index + 1 + Number(limit));
  return { items: page, nextCursor: index + 1 + page.length < items.length ? identify(page.at(-1)!) : null };
}
