import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { handleRuntimeReplayBridgeMessage } from "../../bridge/runtime-replay.js";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { createLocalServiceClients } from "../local-host/client-services.js";
import { dispatchLocalServiceCall } from "../local-host/app-service-dispatch.js";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
const originalReceipt = {
  sessionId: "session",
  deleted: true,
  deletedMessages: 2,
  deletedRequests: 1,
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const f = await createSchedulerRuntimeFixture();
  cleanups.push(f.dispose);
  const { sessions, attachments } = f.application.services;
  await sessions.startRequestStream("session", "request");
  const reference = await attachments.saveAttachment({
    sessionId: "session",
    requestId: "request",
    kind: "file",
    mimeType: "text/plain",
    bytes: Buffer.from("attachment evidence"),
    name: "evidence.txt",
  });
  const { absolutePath } = await attachments.resolveAttachment(reference);
  const remove = vi
    .spyOn(attachments, "deleteSessionAttachments")
    .mockRejectedValueOnce(new Error("attachment_cleanup_failed"));
  return { ...f, sessions, absolutePath, remove };
}

test("composed boolean deletion retains attachment cleanup and original stats until explicit retry", async () => {
  const f = await fixture();
  await expect(f.sessions.deleteSession("session")).rejects.toThrow(
    "attachment_cleanup_failed",
  );
  expect(await f.sessions.getSessionById("session")).toBeNull();
  expect(await readFile(f.absolutePath, "utf8")).toBe("attachment evidence");
  await expect(
    f.sessions.appendMessage("session", "assistant", "late"),
  ).rejects.toMatchObject({ code: "session_deleted" });
  await expect(f.sessions.deleteSessionWithStats("session")).resolves.toEqual(
    originalReceipt,
  );
  await expect(readFile(f.absolutePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.remove).toHaveBeenCalledTimes(2);
  await expect(f.sessions.deleteSession("session")).resolves.toBe(false);
  expect(f.remove).toHaveBeenCalledTimes(2);
  expect(f.invoke).not.toHaveBeenCalled();
});

async function managedClients(f: Awaited<ReturnType<typeof fixture>>) {
  const calls: string[] = [];
  const connection = await createLocalRuntimeConnection({
    directory: join(f.rootDir, "attachment-local-host"),
    identity: "attachment-owner-test",
    createOwner: async () => ({
      call: (method, args) => {
        calls.push(method);
        return dispatchLocalServiceCall(f.application.services, method, args);
      },
      subscribe: () => () => {},
      stop: () => f.application.stop(),
    }),
  });
  cleanups.push(() => connection.close());
  return { clients: createLocalServiceClients(connection.call), calls };
}

async function webDelete(
  f: Awaited<ReturnType<typeof fixture>>,
  clients: ReturnType<typeof createLocalServiceClients>,
) {
  vi.spyOn(RuntimeEnvironmentRegistry.prototype, "get").mockReturnValue({
    services: { ...clients, config: f.config },
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const port = (server.address() as AddressInfo).port;
  return async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/web-api/chat/sessions/session`,
      { method: "DELETE" },
    );
    return (await response.json()) as Record<string, unknown>;
  };
}

function bridgeDelete(clients: ReturnType<typeof createLocalServiceClients>) {
  return async () => {
    let response: Record<string, unknown> | undefined;
    const ws = {
      send: (data: string) => {
        response = JSON.parse(data) as Record<string, unknown>;
      },
    };
    await handleRuntimeReplayBridgeMessage(
      ws as never,
      {
        type: "session.delete.request",
        correlationId: "delete",
        sessionId: "session",
      },
      { sessionStore: clients.sessions, attachmentStore: clients.attachments },
    );
    return response!;
  };
}

test.each(["Web", "Bridge"] as const)(
  "%s deletion through real local RPC completes attachments in the owner without a second cleanup RPC",
  async (kind) => {
    const f = await fixture();
    const { clients, calls } = await managedClients(f);
    const remove =
      kind === "Web" ? await webDelete(f, clients) : bridgeDelete(clients);
    expect(await remove()).toMatchObject({ ok: false });
    expect(await f.sessions.getSessionById("session")).toBeNull();
    expect(await readFile(f.absolutePath, "utf8")).toBe("attachment evidence");
    expect(await remove()).toMatchObject({ ok: true, ...originalReceipt });
    await expect(readFile(f.absolutePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(f.remove).toHaveBeenCalledTimes(2);
    expect(await remove()).toMatchObject({
      ok: true,
      deleted: false,
      deletedMessages: 0,
      deletedRequests: 0,
    });
    expect(f.remove).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(Array(3).fill("sessions.deleteSessionWithStats"));
    expect(f.invoke).not.toHaveBeenCalled();
  },
);
