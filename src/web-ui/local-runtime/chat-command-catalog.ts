import type { ServerResponse } from "node:http";
import { RUNTIME_COMMANDS } from "../../runtime/commands/catalog.js";
import { sendJson } from "./http.js";

export function handleChatCommandCatalog(
  method: string,
  route: string,
  response: ServerResponse,
): boolean {
  if (method !== "GET" || route !== "chat/commands") return false;
  sendJson(response, 200, { commands: RUNTIME_COMMANDS });
  return true;
}
