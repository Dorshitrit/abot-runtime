import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  test("includes an unread conversation beyond 500 through one canonical disk read without session RPC", async () => {
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
    expect(readAll).toHaveBeenCalledTimes(1);
    for (const method of Object.values(managedSessions))
      expect(method).not.toHaveBeenCalled();
  });
});
