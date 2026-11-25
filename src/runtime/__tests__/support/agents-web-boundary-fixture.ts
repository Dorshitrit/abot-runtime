import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { vi } from "vitest";
import { SessionService } from "../../../sessions/session-service.js";
import { FileAgentStateStore } from "../../agents/file-store.js";
import type { RuntimeEnvironment } from "../../../web-ui/local-runtime/contracts.js";
import { WebSessionReadStates } from "../../../web-ui/session-read-state/service.js";
import { agentDefinition, commitAgentCommand } from "./agents-foundation-fixture.js";

export async function agentsWebBoundaryFixture() {
  const root = await mkdtemp(join(tmpdir(), "agents-web-boundary-"));
  const sessionsDir = join(root, "sessions"); await mkdir(sessionsDir);
  const store = new FileAgentStateStore(join(root, "agents", "state.json"));
  await commitAgentCommand(store, { kind: "register_agent", agentId: "agent-a", definition: agentDefinition() });
  for (const sessionId of ["agent-new", "agent-old"])
    await commitAgentCommand(store, { kind: "bind_session", agentId: "agent-a", sessionId, purpose: "Fixture work" });
  const sessions = new SessionService({ sessionsDir });
  const environment = { services: { config: { paths: { runtimeDir: root, sessionsDir }, webUi: { pageSize: 2 } }, sessions } } as unknown as RuntimeEnvironment;
  const reads = new WebSessionReadStates(() => environment, () => 0);
  for (const [id, timestamp] of [["chat-old", 1000], ["agent-old", 2000], ["chat-middle", 3000], ["chat-new", 4000], ["agent-new", 5000]] as const) {
    const createdAt = new Date(timestamp).toISOString();
    await writeFile(join(sessionsDir, `${id}.json`), JSON.stringify({ id, title: id, createdAt, updatedAt: createdAt,
      lastAgentMode: "reasoning", messageCount: 1, messages: [{ id: "msg-1", role: "assistant", content: `Result for ${id}`, createdAt }] }));
  }
  return { root, store, sessions, reads, environment, dispose: () => rm(root, { recursive: true, force: true }) };
}

export function boundaryResponse() {
  let payload: Record<string, unknown> = {};
  const writeHead = vi.fn();
  const response = { writeHead, end(raw: string) { payload = JSON.parse(raw); } } as unknown as ServerResponse;
  return { response, writeHead, get payload() { return payload; } };
}
