import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RuntimeConfig } from "../ports.js";
import { SessionService } from "../../sessions/session-service.js";
import type { SessionRecord } from "../../sessions/types.js";
import { WebSessionReadStates } from "../../web-ui/session-read-state/service.js";

const roots: string[] = [];
const iso = (timestamp: number) => new Date(timestamp).toISOString();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function session(index: number): SessionRecord {
  const createdAt = iso(3000 + index);
  return {
    id: `session-${index}`,
    title: `Conversation ${index}`,
    createdAt,
    updatedAt: createdAt,
    lastAgentMode: "reasoning",
    messageCount: 1,
    messages: [{ id: "msg-1", role: "user", content: "Question", createdAt }],
  };
}

describe("Web UI read-state session listing", () => {
  test("includes an unread conversation beyond 500 through metadata without session RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "web-read-list-"));
    roots.push(root);
    const sessionsDir = join(root, "sessions");
    await mkdir(sessionsDir);
    const records = Array.from({ length: 501 }, (_, index) => session(index));
    const oldest = records[500]!;
    Object.assign(oldest, {
      title: "Unopened Job result",
      createdAt: iso(2000),
      updatedAt: iso(2200),
      messageCount: 2,
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "Visible Job\n  result",
          createdAt: iso(2000),
          requestId: "job-request",
          source: "cron",
        },
        {
          id: "msg-2",
          role: "assistant",
          content: "Hidden tool observation",
          createdAt: iso(2200),
          grounding: "tool_observation",
        },
      ],
    } satisfies Partial<SessionRecord>);
    await Promise.all(
      records.map((record) =>
        writeFile(
          join(sessionsDir, `${record.id}.json`),
          JSON.stringify(record),
        ),
      ),
    );
    const forbiddenRpc = () => {
      throw new Error(
        "Listing must not send complete session history over RPC",
      );
    };
    const managedSessions = {
      getAllSessions: vi.fn(forbiddenRpc),
      listSessions: vi.fn(forbiddenRpc),
      getSessionSnapshot: vi.fn(forbiddenRpc),
    };
    const readAll = vi.spyOn(SessionService.prototype, "getAllSessions");
    const service = new WebSessionReadStates(
      () => ({
        services: {
          config: { paths: { runtimeDir: root, sessionsDir } } as RuntimeConfig,
          sessions: managedSessions,
        },
      }),
      () => 1000,
    );

    const result = await service.list("prod");

    expect(result.sessions).toHaveLength(501);
    expect(new Set(result.sessions.map((value) => value.id)).size).toBe(501);
    expect(result.nextCursor).toBeNull();
    expect(result.sessions.at(-1)).toMatchObject({
      id: oldest.id,
      title: "Unopened Job result",
      updatedAt: 2200,
      lastMessagePreview: "Visible Job result",
      latestMessageId: 1,
      latestAssistantMessageId: 1,
      hasUnread: true,
      unreadCount: 1,
    });
    expect(result.sessions.filter((value) => value.hasUnread)).toHaveLength(1);
    expect(readAll).not.toHaveBeenCalled();
    expect(await service.list("prod")).toEqual(result);
    for (const method of Object.values(managedSessions))
      expect(method).not.toHaveBeenCalled();
  });

  test("backfill preserves existing read cursors and history across restart and keeps internal sessions hidden", async () => {
    const root = await mkdtemp(join(tmpdir(), "web-read-backfill-"));
    roots.push(root);
    const sessionsDir = join(root, "sessions");
    await mkdir(sessionsDir);
    const record = session(1);
    record.messages = [
      { id: "msg-1", role: "assistant", content: "Before tracking", createdAt: iso(900) },
      { id: "msg-2", role: "user", content: "Question", createdAt: iso(1100) },
      { id: "msg-3", role: "assistant", content: "Read answer", createdAt: iso(1200) },
      { id: "msg-4", role: "assistant", content: "Unread answer", createdAt: iso(1300) },
    ];
    record.messageCount = record.messages.length;
    const bytes = JSON.stringify(record);
    await writeFile(join(sessionsDir, `${record.id}.json`), bytes);
    await writeFile(join(sessionsDir, "spark-companion.json"), JSON.stringify({ ...record, id: "spark-companion", kind: "spark" }));
    await writeFile(join(sessionsDir, "internal.json"), JSON.stringify({
      ...record, id: "internal", automationOrigin: { kind: "automation_node_v1" },
    }));
    const environment = () => ({ services: {
      config: { paths: { runtimeDir: root, sessionsDir } } as RuntimeConfig,
      sessions: new SessionService({ sessionsDir }),
    } });
    const service = new WebSessionReadStates(environment, () => 1000);
    await service.mark("prod", record.id, { readThroughMessageId: 3 });
    const key = createHash("sha256").update(JSON.stringify(["prod", sessionsDir])).digest("hex");
    const readStatePath = join(root, "web-ui", "read-state", `${key}.json`);
    const readStateBefore = await readFile(readStatePath, "utf8");

    const first = await service.list("prod");
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]).toMatchObject({
      id: record.id, unreadCount: 1, lastReadMessageId: "3", latestAssistantMessageId: 4,
    });
    const restarted = new WebSessionReadStates(environment, () => 9000);
    expect(await restarted.list("prod")).toEqual(first);
    expect(await readFile(readStatePath, "utf8")).toBe(readStateBefore);
    expect(await readFile(join(sessionsDir, `${record.id}.json`), "utf8")).toBe(bytes);
  });
});
