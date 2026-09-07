import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { handleRuntimeReplayBridgeMessage } from "../../bridge/runtime-replay.js";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createFileAttachmentStore } from "../attachments/store.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const expectedReceipt = {
  sessionId: "deleted",
  deleted: true,
  deletedMessages: 2,
  deletedRequests: 1,
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(failure: "listener" | "attachment") {
  const rootDir = await mkdtemp(join(tmpdir(), "deletion-attachments-"));
  temporaryDirectories.push(rootDir);
  const base = createInMemorySessionStore();
  const lifetime = createSessionLifecycleStore(base);
  await lifetime.store.appendMessage("deleted", "user", "question");
  await lifetime.store.appendMessage("deleted", "assistant", "answer");
  await lifetime.store.startRequestStream("deleted", "request");
  const cleanup = vi.fn(async () => undefined);
  if (failure === "listener")
    cleanup.mockRejectedValueOnce(new Error("cleanup_failed"));
  const succeeded = vi.fn(async () => undefined);
  lifetime.onDeleted(cleanup);
  lifetime.onDeleted(succeeded);
  const attachments = createFileAttachmentStore({
    attachmentsDir: join(rootDir, "attachments"),
  });
  const attachment = await attachments.saveAttachment({
    sessionId: "deleted",
    requestId: "request",
    kind: "file",
    mimeType: "text/plain",
    bytes: Buffer.from("attached evidence"),
    name: "evidence.txt",
  });
  const { absolutePath } = await attachments.resolveAttachment(attachment);
  const removeAttachments = vi.spyOn(attachments, "deleteSessionAttachments");
  if (failure === "attachment")
    removeAttachments.mockRejectedValueOnce(new Error("cleanup_failed"));
  return {
    failure,
    rootDir,
    base,
    lifetime,
    cleanup,
    succeeded,
    attachments,
    absolutePath,
    removeAttachments,
  };
}

async function assertFailedCleanup(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.base.getSessionById("deleted")).toBeNull();
  expect(f.lifetime.isDeleted("deleted")).toBe(true);
  expect(await readFile(f.absolutePath, "utf8")).toBe("attached evidence");
  expect(f.removeAttachments).toHaveBeenCalledTimes(
    f.failure === "attachment" ? 1 : 0,
  );
}

async function assertCompleteCleanup(f: Awaited<ReturnType<typeof fixture>>) {
  await expect(readFile(f.absolutePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.removeAttachments).toHaveBeenLastCalledWith("deleted");
  expect(f.removeAttachments).toHaveBeenCalledTimes(
    f.failure === "attachment" ? 2 : 1,
  );
  expect(f.cleanup).toHaveBeenCalledTimes(f.failure === "listener" ? 2 : 1);
  expect(f.succeeded).toHaveBeenCalledOnce();
}

test.each(["listener", "attachment"] as const)(
  "Web DELETE retry after %s failure removes actual attachments using the original deletion receipt",
  async (failure) => {
    const f = await fixture(failure);
    vi.spyOn(RuntimeEnvironmentRegistry.prototype, "get").mockReturnValue({
      services: {
        sessions: f.lifetime.store,
        attachments: f.attachments,
        config: {
          paths: {
            sessionsDir: join(f.rootDir, "sessions"),
            runtimeDir: join(f.rootDir, "runtime"),
          },
        },
      },
    } as unknown as RuntimeEnvironment);
    const backend = new LocalRuntimeWebBackend({
      rootDir: f.rootDir,
      defaultEnvironmentId: "test",
    });
    const server = createServer((req, res) => {
      void backend.handleHttp(
        req,
        res,
        new URL(req.url || "/", "http://localhost").pathname,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const remove = () =>
      fetch(
        `http://127.0.0.1:${port}/web-api/chat/sessions/deleted?environment=test`,
        {
          method: "DELETE",
        },
      );

    const failed = await remove();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({
      ok: false,
      message: "cleanup_failed",
    });
    await assertFailedCleanup(f);
    const retried = await remove();
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ ok: true, ...expectedReceipt });
    await assertCompleteCleanup(f);
    expect(await (await remove()).json()).toMatchObject({
      ok: true,
      deleted: false,
      deletedMessages: 0,
      deletedRequests: 0,
    });
    await assertCompleteCleanup(f);
  },
);

test.each(["listener", "attachment"] as const)(
  "Bridge delete retry after %s failure removes actual attachments using the original deletion receipt",
  async (failure) => {
    const f = await fixture(failure);
    const sent: Record<string, unknown>[] = [];
    const ws = {
      send: (data: string) =>
        sent.push(JSON.parse(data) as Record<string, unknown>),
    };
    async function remove() {
      expect(
        await handleRuntimeReplayBridgeMessage(
          ws as never,
          {
            type: "session.delete.request",
            correlationId: "delete",
            sessionId: "deleted",
          },
          { sessionStore: f.lifetime.store, attachmentStore: f.attachments },
        ),
      ).toBe(true);
      return sent.at(-1);
    }

    expect(await remove()).toMatchObject({
      ok: false,
      error: "cleanup_failed",
    });
    await assertFailedCleanup(f);
    expect(await remove()).toEqual({
      type: "session.delete.response",
      correlationId: "delete",
      ok: true,
      ...expectedReceipt,
    });
    await assertCompleteCleanup(f);
    expect(await remove()).toMatchObject({
      ok: true,
      deleted: false,
      deletedMessages: 0,
      deletedRequests: 0,
    });
    await assertCompleteCleanup(f);
  },
);
