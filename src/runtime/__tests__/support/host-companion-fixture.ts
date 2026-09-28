import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { WebSystemHostService } from "../../../web-ui/system-host-service.js";
import type { HostIdentity } from "../../../computer-access/companion/protocol.js";

export const testHostIdentity: HostIdentity = {
  name: "QA computer",
  os: "windows",
  user: "tester",
  homeDir: "C:\\Users\\tester",
};
export function nextHostMessage(
  socket: WebSocket,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onClose = () => {
      socket.removeListener("message", onMessage);
      reject(new Error("host_socket_closed"));
    };
    const onMessage = (data: WebSocket.RawData) => {
      socket.removeListener("close", onClose);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}
export async function hostCompanionFixture(connectionChanged?: () => void) {
  const rootDir = await mkdtemp(join(tmpdir(), "abot-host-test-"));
  let service = new WebSystemHostService(rootDir, connectionChanged);
  const server = createServer((request, response) => {
    void service
      .handleHttp(
        request,
        response,
        new URL(request.url ?? "/", "http://localhost").pathname,
      )
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
  });
  server.on("upgrade", (request, socket, head) => {
    if (!service.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const api = async (suffix = "", method = "GET", origin?: string) => {
    const response = await fetch(
      base + "/web-api/runtime/system-host" + suffix,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        ...(method === "GET" ? {} : { body: "{}" }),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  const open = (token: string, origin?: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${port}/system-host/connect`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...(origin ? { Origin: origin } : {}),
          },
        },
      );
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
  const pair = async () => {
    const { body } = await api("/pairing", "POST");
    const socket = await open(String(body.code));
    const message = nextHostMessage(socket);
    socket.send(
      JSON.stringify({ type: "hello", version: 1, identity: testHostIdentity }),
    );
    const grant = await message;
    socket.terminate();
    return {
      hostId: String(grant.hostId),
      credential: String(grant.credential),
      code: String(body.code),
    };
  };
  const activate = async (grant: { hostId: string; credential: string }) => {
    const socket = await open(grant.credential);
    const message = nextHostMessage(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        version: 1,
        hostId: grant.hostId,
        identity: testHostIdentity,
      }),
    );
    await message;
    return socket;
  };
  return {
    rootDir,
    base,
    api,
    open,
    pair,
    activate,
    async restart() {
      await service.close();
      service = new WebSystemHostService(rootDir, connectionChanged);
    },
    async close() {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}
