import type WebSocket from "ws";
import type { AgentWorkspaceClient } from "../runtime/agents/workspace-client-contracts.js";
import { AGENT_REMOTE_FIELDS, AGENT_REMOTE_READS, AGENT_REMOTE_RESPONSE_BYTES, AGENTS_REMOTE_FEATURE } from "../runtime/agents/remote-workspace-input.js";
export { AGENTS_REMOTE_FEATURE };

export type BridgeAgentsAccess = Pick<AgentWorkspaceClient, "remote">;
function publicAgentsError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^(?:agents_|agent_|approval_)[a-z0-9_]{1,100}$/.test(message)) return message;
  return "agents_service_unavailable";
}
/** Invalidation carries no chat content and is scoped by the relay to this runtime generation. */
export function connectBridgeAgentEvents(subscribe: ((listener: (revision: number) => void) => () => void) | undefined,
  currentSocket: () => WebSocket | undefined): () => void {
  return subscribe?.(revision => {
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    const socket = currentSocket();
    if (socket?.readyState !== 1) return;
    socket.send(JSON.stringify({ type: "agents.changed", revision }));
  }) ?? (() => {});
}
/** A reply acknowledges admission; completion is read from the persisted workspace. */
export async function handleAgentsBridgeMessage(socket: WebSocket, message: Record<string, unknown>,
  access: BridgeAgentsAccess | undefined): Promise<boolean> {
  if (typeof message.type !== "string" || !message.type.startsWith("agents.")) return false;
  const response = {
    type: message.type.replace(/\.request$/, ".response"),
    correlationId: typeof message.correlationId === "string" ? message.correlationId : "",
    ...(typeof message.targetAgentId === "string" ? { targetAgentId: message.targetAgentId } : {}),
    ...(typeof message.clientMessageId === "string" ? { clientMessageId: message.clientMessageId } : {}),
    ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {}),
  };
  const send = (body: Record<string, unknown>) => {
    if (socket.readyState !== undefined && socket.readyState !== 1) return;
    socket.send(JSON.stringify({ ...response, ...body }));
  };
  if (!access) { send({ ok: false, error: "agents_unsupported" }); return true; }
  try {
    if (!Object.hasOwn(AGENT_REMOTE_FIELDS, message.type)) throw new Error("agents_input_command");
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(response.correlationId)) throw new Error("agents_input_correlation");
    const { correlationId: _correlationId, ...command } = message;
    const data = await access.remote(command);
    if (Buffer.byteLength(JSON.stringify({ ...response, ok: true, data })) <= AGENT_REMOTE_RESPONSE_BYTES) {
      send({ ok: true, data });
    } else {
      const agentId = message.targetAgentId ?? (data.agent as { id?: string } | undefined)?.id;
      if (AGENT_REMOTE_READS.has(message.type) || typeof agentId !== "string") throw new Error("agents_response_too_large");
      send({ ok: true, data: { acknowledged: true, needsRefetch: true, targetAgentId: agentId } });
    }
  } catch (error) { send({ ok: false, error: publicAgentsError(error) }); }
  return true;
}
