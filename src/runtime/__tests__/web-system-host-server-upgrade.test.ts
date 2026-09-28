import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startWebUiServer } from "../../web-ui/server.js";

const mock = vi.hoisted(() => ({
  server: undefined as Server | undefined,
  realtime: vi.fn(),
}));
vi.mock(
  "../../computer-access/host-observation.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../computer-access/host-observation.js")
      >();
    return {
      ...actual,
      readSystemHostFacts: () => ({
        platform: "linux",
        kernelRelease: "linux",
        containerMarker: false,
      }),
    };
  },
);
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      mock.server = actual.createServer(...args);
      return mock.server;
    },
  };
});
vi.mock("../../web-ui/local-runtime-backend.js", () => ({
  LocalRuntimeWebBackend: class {
    start = async () => {};
    stop = async () => {};
    notifyHostConnectionChanged = () => {};
    handleRealtimeConnection = mock.realtime;
  },
}));

let handle: ReturnType<typeof startWebUiServer>;
let rootDir: string;
let port: number;
let code: string;
let duplicateHost = false;
beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  rootDir = await mkdtemp(join(tmpdir(), "abot-native-upgrade-"));
  handle = startWebUiServer({
    host: "0.0.0.0",
    port: 0,
    backend: "runtime",
    rootDir,
  });
  if (!mock.server!.listening) await once(mock.server!, "listening");
  port = (mock.server!.address() as { port: number }).port;
  const response = await fetch(
    `http://127.0.0.1:${port}/web-api/runtime/system-host/pairing`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  expect(response.status).toBe(200);
  code = ((await response.json()) as { code: string }).code;
  mock.server!.prependListener("upgrade", (request) => {
    Object.defineProperty(request.socket, "localAddress", {
      value: "172.17.0.2",
    });
    Object.defineProperty(request.socket, "localPort", { value: 5177 });
    if (duplicateHost) request.rawHeaders.push("Host", "attacker.example:5184");
  });
});
afterEach(async () => {
  await handle?.close();
  await rm(rootDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  mock.realtime.mockClear();
  duplicateHost = false;
});

async function upgrade(
  headers: Record<string, string>,
  path = "/system-host/connect",
) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  try {
    await once(socket, "open");
    return true;
  } catch {
    return false;
  } finally {
    socket.terminate();
  }
}
test.each(["localhost", "abot-qa.localhost", "127.0.0.1", "[::1]"])(
  "admits authenticated native upgrades for forwarded loopback Host %s with a mapped port",
  async (host) => {
    expect(
      await upgrade({ host: `${host}:5184`, authorization: `Bearer ${code}` }),
    ).toBe(true);
    expect(mock.realtime).not.toHaveBeenCalled();
  },
);
test.each<Record<string, string>>([
  { host: "attacker.example:5184", "x-forwarded-host": "localhost:5184" },
  { host: "localhost.attacker.example:5184" },
  { host: "localhost:5184", origin: "http://localhost:5184" },
  { host: "localhost:5184", "sec-fetch-site": "none" },
  { host: "localhost:5184", authorization: "Bearer invalid" },
  { host: "localhost:5184", authorization: `Bearer ${"a".repeat(43)}` },
])(
  "rejects unauthenticated or browser-like native upgrade %j",
  async (headers) => {
    expect(await upgrade({ authorization: `Bearer ${code}`, ...headers })).toBe(
      false,
    );
  },
);
test("rejects duplicate native Host headers", async () => {
  duplicateHost = true;
  expect(
    await upgrade({ host: "localhost:5184", authorization: `Bearer ${code}` }),
  ).toBe(false);
});
test("does not relax browser realtime authority for native-looking credentials", async () => {
  expect(
    await upgrade(
      { host: "localhost:5184", authorization: `Bearer ${code}` },
      "/web-realtime",
    ),
  ).toBe(false);
  expect(mock.realtime).not.toHaveBeenCalled();
});
