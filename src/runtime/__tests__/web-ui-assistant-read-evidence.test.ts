import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { ensureSparkSession, SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import type { SessionMessageIdentity } from "../../sessions/snapshot.js";
import { projectAssistantReadEvidence } from "../../web-ui/session-read-state/assistant-read-evidence.js";
import { WebSessionReadStates } from "../../web-ui/session-read-state/service.js";
import type { WebReadState } from "../../web-ui/session-read-state/store.js";
import type { RuntimeConfig } from "../ports.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function message(id: number, createdAt: number, requestId = `request-${id}`): SessionMessageIdentity {
  return { id, role: "assistant", createdAt, requestId };
}
function readState(): WebReadState { return { version: 1, initializedAt: 1000, cursors: [] }; }
function snapshot(messages: SessionMessageIdentity[], kind?: "spark") {
  return { sessionId: "chat", kind, messages: [], messageIndex: messages };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "assistant-read-evidence-")); roots.push(root);
  let now = 1000;
  const services = new Map<string, SessionService>();
  const environment = (id: string) => {
    const paths = { runtimeDir: join(root, id), sessionsDir: join(root, id, "sessions") };
    let sessions = services.get(id);
    if (!sessions) {
      sessions = new SessionService({ sessionsDir: paths.sessionsDir, now: () => new Date(now) });
      services.set(id, sessions);
    }
    return { services: { config: { paths } as RuntimeConfig, sessions } };
  };
  const reads = new WebSessionReadStates(environment, () => now);
  return { root, reads, environment, setNow: (value: number) => { now = value; } };
}

async function persistedReadState(root: string) {
  const directory = join(root, "dev", "web-ui", "read-state");
  const [filename] = await readdir(directory);
  return join(directory, filename!);
}

describe("explicit assistant read evidence", () => {
  test("does not interpret the migration baseline as viewing, and keeps unread later replies with reused request IDs", () => {
    const state = readState();
    const current = snapshot([message(1, 100, "reused"), message(2, 200, "reused"), message(3, 300)]);
    expect(projectAssistantReadEvidence(state, current).messages.map((item) => item.readAt)).toEqual([null, null, null]);
    state.cursors = [["chat", { messageId: "1", createdAt: 100, lastReadAt: 1500 }]];
    expect(projectAssistantReadEvidence(state, current)).toEqual({ status: "available", messages: [
      { messageId: "1", createdAt: 100, requestId: "reused", readAt: 1500 },
      { messageId: "2", createdAt: 200, requestId: "reused", readAt: null },
      { messageId: "3", createdAt: 300, requestId: "request-3", readAt: null },
    ] });
  });

  test("uses the canonical cursor position rather than numeric ID ordering and excludes user messages", () => {
    const state = readState();
    const user = { ...message(2, 200), role: "user" as const };
    const proposal = { ...message(8, 300), id: "initiative:proposal" };
    state.cursors = [["chat", { messageId: proposal.id, createdAt: 300, lastReadAt: 1600 }]];
    const result = projectAssistantReadEvidence(state, snapshot([message(10, 100), user, proposal, message(1, 400)]));
    expect(result.messages.map(({ messageId, readAt }) => [messageId, readAt]))
      .toEqual([["10", 1600], ["initiative:proposal", 1600], ["1", null]]);
  });

  test.each([
    { messageId: "missing", createdAt: 100 },
    { messageId: "1", createdAt: 99 },
    { messageId: "2", createdAt: 200 },
  ])("rejects a missing, replaced or non-assistant cursor: %j", (cursor) => {
    const state = readState();
    state.cursors = [["chat", { ...cursor, lastReadAt: 1500 }]];
    const current = snapshot([message(1, 100), { ...message(2, 200), role: "user" as const }, message(3, 300)]);
    expect(projectAssistantReadEvidence(state, current).messages.map((item) => item.readAt)).toEqual([null, null]);
  });

  test("SPARK preserves sparse receipts and rejects stale timestamps or request identities without creating read state", () => {
    const state = readState();
    const current = snapshot([message(1, 100), message(2, 200), message(3, 300), message(4, 400)], "spark");
    const untouched = JSON.stringify(state);
    expect(projectAssistantReadEvidence(state, current).messages.map((item) => item.readAt)).toEqual([null, null, null, null]);
    expect(JSON.stringify(state)).toBe(untouched);
    state.visibleMessages = [["chat", { generation: "current", revision: 1700, messages: [
      { messageId: "1", createdAt: 100, requestId: "request-1" },
      { messageId: "2", createdAt: 199, requestId: "request-2" },
      { messageId: "3", createdAt: 300, requestId: "request-3" },
      { messageId: "4", createdAt: 400, requestId: "old-request" },
    ] }]];
    const before = JSON.stringify(state);
    expect(projectAssistantReadEvidence(state, current).messages.map((item) => item.readAt)).toEqual([1700, null, 1700, null]);
    expect(JSON.stringify(state)).toBe(before);
  });

  test("queries persisted identities only, preserves canonical history and survives restart without crossing environments", async () => {
    const f = await fixture(); const sessions = f.environment("dev").services.sessions;
    await sessions.appendMessage("chat", "assistant", "First", { requestId: "first" });
    f.setNow(1100); await f.reads.mark("dev", "chat", { readThroughMessageId: 1 });
    f.setNow(1200); await sessions.appendMessage("chat", "assistant", "Later", { requestId: "later" });
    const sessionPath = join(f.root, "dev", "sessions", "chat.json");
    const original = await readFile(sessionPath, "utf8");
    const statePath = await persistedReadState(f.root);
    const stateBytes = await readFile(statePath, "utf8");
    const getSnapshot = vi.spyOn(sessions, "getSessionSnapshot");
    const expected = { status: "available", messages: [
      { messageId: "1", createdAt: 1000, requestId: "first", readAt: 1100 },
      { messageId: "2", createdAt: 1200, requestId: "later", readAt: null },
    ] };
    expect(await f.reads.assistantReadEvidence("dev", "chat")).toEqual(expected);
    expect(getSnapshot).toHaveBeenLastCalledWith("chat", { includeRequests: false, identitiesOnly: true });
    expect(await new WebSessionReadStates(f.environment, () => 9000).assistantReadEvidence("dev", "chat")).toEqual(expected);
    expect(await readFile(sessionPath, "utf8")).toBe(original);
    expect(await readFile(statePath, "utf8")).toBe(stateBytes);
    await f.environment("prod").services.sessions.appendMessage("chat", "assistant", "Other", { requestId: "first" });
    expect(await f.reads.assistantReadEvidence("prod", "chat")).toMatchObject({ status: "available", messages: [{ readAt: null }] });
  });

  test.each([false, true])("reset and clear invalidate reused identities (SPARK=%s)", async (spark) => {
    const f = await fixture(); const sessions = f.environment("dev").services.sessions;
    const id = spark ? SPARK_SESSION_ID : "chat";
    if (spark) await ensureSparkSession(sessions);
    await sessions.appendMessage(id, "assistant", "Before", { requestId: "reused" });
    if (spark) {
      const before = (await sessions.getSessionSnapshot(id))!;
      const state = await f.reads.project("dev", before);
      const generation = "readGeneration" in state ? state.readGeneration : "";
      await f.reads.markVisible("dev", id, [1], generation, [{ id: 1, createdAt: 1000, requestId: "reused" }]);
    } else await f.reads.mark("dev", id, { readThroughMessageId: 1 });
    const original = await f.reads.assistantReadEvidence("dev", id);
    expect(original).toMatchObject({ status: "available", messages: [{ readAt: expect.any(Number) }] });
    await sessions.clearSessionMessages(id); await f.reads.reset("dev", id);
    // Same numeric ID, time and request ID must not inherit cleared receipts.
    await sessions.appendMessage(id, "assistant", "After", { requestId: "reused" });
    expect(await f.reads.assistantReadEvidence("dev", id)).toEqual({ status: "available", messages: [
      { messageId: "1", createdAt: 1000, requestId: "reused", readAt: null },
    ] });
    await f.reads.forget("dev", id);
    expect(await f.reads.assistantReadEvidence("dev", id)).toMatchObject({ status: "available", messages: [{ readAt: null }] });
  });

  test("missing sessions, snapshot failures and corrupt sidecars are unavailable rather than read", async () => {
    const f = await fixture(); const sessions = f.environment("dev").services.sessions;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await f.reads.assistantReadEvidence("dev", "missing")).toEqual({ status: "unavailable" });
    expect(await sessions.getSessionById("missing")).toBeNull();
    await sessions.appendMessage("chat", "assistant", "Unread", { requestId: "request" });
    const getSnapshot = vi.spyOn(sessions, "getSessionSnapshot").mockRejectedValueOnce(new Error("snapshot offline"));
    expect(await f.reads.assistantReadEvidence("dev", "chat")).toEqual({ status: "unavailable" });
    getSnapshot.mockRestore();
    await writeFile(await persistedReadState(f.root), "invalid json");
    expect(await f.reads.assistantReadEvidence("dev", "chat")).toEqual({ status: "unavailable" });
    expect(log).toHaveBeenCalledTimes(2);
  });
});
