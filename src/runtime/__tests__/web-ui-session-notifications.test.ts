import { EventEmitter } from "node:events";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type WebSocket from "ws";
import { WebSessionRoutes } from "../../web-ui/local-runtime/session-routes.js";
import { afterEach, describe, expect, test } from "vitest";
import {
  createNativeSessionHttpFixture,
  type NativeSessionHttpFixture,
} from "./support/web-ui-native-session-http.js";

const fixtures: NativeSessionHttpFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

async function fixture(environment = "prod") {
  const f = await createNativeSessionHttpFixture();
  fixtures.push(f);
  const frames: Record<string, unknown>[] = [];
  f.connectRealtime(
    Object.assign(new EventEmitter(), {
      OPEN: 1,
      readyState: 1,
      send(raw: string) {
        frames.push(JSON.parse(raw));
      },
    }) as unknown as WebSocket,
  );
  await f
    .sessions(environment)
    .appendMessage("conversation", "user", "Question");
  await f.request("GET", "", undefined, environment);
  await f
    .sessions(environment)
    .appendMessage("conversation", "assistant", "Answer");
  return { f, frames };
}

function expectSessionChange(
  frames: Record<string, unknown>[],
  environment = "prod",
) {
  expect(frames).toEqual([
    { type: "workspace_changed", environment, resources: ["sessions"] },
  ]);
}

describe("native session mutation notifications through HTTP and realtime composition", () => {
  test.each(["reset", "attachments", "forget"])(
    "a committed mutation still notifies when %s cleanup fails, preserving the failure",
    async (failingCleanup) => {
      const error = new Error(`${failingCleanup} unavailable`);
      const calls: string[] = [];
      const cleanup = async (name: string) => {
        calls.push(name);
        if (name === failingCleanup) throw error;
      };
      const routes = new WebSessionRoutes(
        {
          reset: () => cleanup("reset"),
          forget: () => cleanup("forget"),
        } as never,
        () => calls.push("notify"),
      );
      const deleting = failingCleanup === "forget";
      const segments = ["chat", "sessions", "conversation"];
      if (!deleting) segments.push("messages");
      const handling = routes.handle({
        method: "DELETE",
        segments,
        body: null,
        environmentId: "prod",
        environment: {
          services: {
            sessions: {
              clearSessionMessages: async () => {
                calls.push("committed");
                return {};
              },
              deleteSessionWithStats: async () => {
                calls.push("committed");
                return {};
              },
            },
            attachments: deleting
              ? undefined
              : {
                  deleteSessionAttachments: () => cleanup("attachments"),
                },
          },
        } as never,
        response: {
          writeHead() {
            throw new Error("must preserve HTTP failure");
          },
        } as never,
      });
      await expect(handling).rejects.toBe(error);
      expect(calls[0]).toBe("committed");
      expect(calls.slice(-2)).toEqual([failingCleanup, "notify"]);
      expect(calls.filter((call) => call === "notify")).toHaveLength(1);
    },
  );

  test("a failed clear before commit emits no invalidation", async () => {
    const error = new Error("mutation not committed");
    const frames: unknown[] = [];
    const routes = new WebSessionRoutes({} as never, (...frame) =>
      frames.push(frame),
    );
    const handling = routes.handle({
      method: "DELETE",
      segments: ["chat", "sessions", "conversation", "messages"],
      body: null,
      environmentId: "prod",
      environment: {
        services: {
          sessions: {
            clearSessionMessages: async () => {
              throw error;
            },
          },
        },
      } as never,
      response: {} as never,
    });
    await expect(handling).rejects.toBe(error);
    expect(frames).toEqual([]);
  });

  test.each(["before commit", "attachment cleanup"])(
    "delete failure at %s preserves its error and requests canonical reconciliation",
    async (failureStage) => {
      const error = new Error("delete unavailable");
      const frames: unknown[] = [];
      let deleted = false;
      const routes = new WebSessionRoutes({} as never, (...frame) =>
        frames.push(frame),
      );
      const handling = routes.handle({
        method: "DELETE",
        segments: ["chat", "sessions", "conversation"],
        body: null,
        environmentId: "prod",
        environment: {
          services: {
            sessions: {
              deleteSessionWithStats: async () => {
                if (failureStage === "before commit") throw error;
                deleted = true;
                return {
                  sessionId: "conversation",
                  deleted: true,
                  deletedMessages: 2,
                  deletedRequests: 0,
                };
              },
            },
            attachments: {
              deleteSessionAttachments: async () => {
                throw error;
              },
            },
          },
        } as never,
        response: {} as never,
      });
      await expect(handling).rejects.toBe(error);
      expect(deleted).toBe(failureStage === "attachment cleanup");
      expect(frames).toEqual([["prod", ["sessions"]]]);
    },
  );

  test("does not notify while the read-state commit is still pending", async () => {
    let finish!: (value: object) => void;
    const committed = new Promise<object>((resolve) => {
      finish = resolve;
    });
    const frames: unknown[] = [];
    const routes = new WebSessionRoutes(
      { mark: () => committed } as never,
      (environment, resources) => frames.push({ environment, resources }),
    );
    const handling = routes.handle({
      method: "POST",
      segments: ["chat", "sessions", "conversation", "read"],
      body: { readThroughMessageId: 2 },
      environmentId: "prod",
      environment: { services: { sessions: {} } } as never,
      response: { writeHead() {}, end() {} } as never,
    });
    await Promise.resolve();
    expect(frames).toEqual([]);
    finish({ lastReadMessageId: "2", unreadCount: 0 });
    expect(await handling).toBe(true);
    expect(frames).toEqual([{ environment: "prod", resources: ["sessions"] }]);
  });

  test("list and snapshot projection remain silent; a read receipt notifies its environment after persistence", async () => {
    const { f, frames } = await fixture("dev");
    expect((await f.request("GET", "", undefined, "dev")).status).toBe(200);
    expect(
      (await f.request("GET", "/conversation/messages", undefined, "dev"))
        .status,
    ).toBe(200);
    expect(frames).toEqual([]);
    const response = await f.request(
      "POST",
      "/conversation/read",
      { readThroughMessageId: 2 },
      "dev",
    );
    expect(response.status).toBe(200);
    expectSessionChange(frames, "dev");
    const snapshot = await (
      await f.request("GET", "/conversation/messages", undefined, "dev")
    ).json();
    expect(snapshot.readState).toMatchObject({
      unreadCount: 0,
      lastReadMessageId: "2",
    });
    expectSessionChange(frames, "dev");
  });

  test.each(["clear", "delete"])(
    "%s notifies only after the requested mutation is visible",
    async (operation) => {
      const { f, frames } = await fixture();
      const suffix =
        operation === "clear" ? "/conversation/messages" : "/conversation";
      const response = await f.request("DELETE", suffix);
      expect(response.status).toBe(200);
      expectSessionChange(frames);
      const session = await f.sessions().getSessionById("conversation");
      if (operation === "clear") expect(session?.messages).toEqual([]);
      else expect(session).toBeNull();
    },
  );

  test("missing read/clear targets and a failed read-state write emit no successful mutation signal", async () => {
    const { f, frames } = await fixture();
    expect(
      (await f.request("POST", "/missing/read", { readThroughMessageId: 1 }))
        .status,
    ).toBe(404);
    expect((await f.request("DELETE", "/missing/messages")).status).toBe(404);
    expect(frames).toEqual([]);
    const directory = join(f.paths().runtimeDir, "web-ui", "read-state");
    const sidecar = (await readdir(directory)).find((name) =>
      name.endsWith(".json"),
    );
    expect(sidecar).toBeDefined();
    await writeFile(join(directory, sidecar!), "{ malformed read state");
    expect(
      (
        await f.request("POST", "/conversation/read", {
          readThroughMessageId: 2,
        })
      ).status,
    ).toBe(500);
    expect(frames).toEqual([]);
  });
});
