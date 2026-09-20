import { once } from "node:events";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startWebUiServer } from "../../web-ui/server.js";

const mock = vi.hoisted(() => ({
  server: undefined as Server | undefined,
  http: vi.fn(),
  realtime: vi.fn(),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));
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
    start = mock.start;
    stop = mock.stop;
    handleHttp = mock.http;
    handleRealtimeConnection = mock.realtime;
    environmentConfig = () => ({
      defaultEnvironmentId: "prod",
      environments: [{ id: "prod", label: "prod", isDefault: true }],
    });
  },
}));

let handle: ReturnType<typeof startWebUiServer>;
let port: number;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  mock.http.mockImplementation(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return true;
  });
  handle = startWebUiServer({
    host: "127.0.0.1",
    port: 0,
    backend: "runtime",
    rootDir: tmpdir(),
  });
  if (!mock.server!.listening) await once(mock.server!, "listening");
  port = (mock.server!.address() as { port: number }).port;
});

afterEach(async () => {
  await handle?.close();
  vi.restoreAllMocks();
  mock.http.mockReset();
  mock.realtime.mockReset();
  mock.start.mockClear();
  mock.stop.mockClear();
});

function send(
  path: string,
  host: string,
  headers: Record<string, string> = {},
  method = "POST",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { host, "content-type": "application/json", ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(method === "GET" ? undefined : "{}");
  });
}

test.each([
  ["/web-api/runtime/setup", "POST"],
  ["/web-api/runtime/setup/embedding", "POST"],
  ["/web-api/runtime/config/models", "POST"],
  ["/web-api/runtime/plugins", "PUT"],
  ["/web-api/runtime/config/apply", "POST"],
])(
  "rejects matching hostile Host/Origin before dispatching %s",
  async (path, method) => {
    const host = "attacker.example:" + port;
    const response = await send(
      path,
      host,
      {
        origin: "http://" + host,
        "sec-fetch-site": "same-origin",
      },
      method,
    );
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body).error).toBe("web_ui_authority_rejected");
    expect(mock.http).not.toHaveBeenCalled();
  },
);

test("rejects unknown authority without Origin before metadata or backend dispatch", async () => {
  const host = "attacker.example:" + port;
  const spoofed = { "x-forwarded-host": "localhost:" + port };
  expect((await send("/web-config", host, spoofed, "GET")).status).toBe(403);
  expect((await send("/web-api/runtime/setup", host, spoofed)).status).toBe(
    403,
  );
  expect(mock.http).not.toHaveBeenCalled();
});

test.each(["127.0.0.1", "localhost"])(
  "preserves canonical %s HTTP access",
  async (host) => {
    expect(
      (await send("/web-api/runtime/setup", host + ":" + port)).status,
    ).toBe(200);
    expect(mock.http).toHaveBeenCalledOnce();
  },
);

test("rejects unknown WebSocket authority before realtime dispatch", async () => {
  const socket = new WebSocket("ws://127.0.0.1:" + port + "/web-realtime", {
    headers: { host: "attacker.example:" + port },
    origin: "http://attacker.example:" + port,
  });
  try {
    await expect(once(socket, "open")).rejects.toThrow();
    expect(mock.realtime).not.toHaveBeenCalled();
  } finally {
    socket.terminate();
  }
});

test("preserves canonical WebSocket authority", async () => {
  const socket = new WebSocket("ws://127.0.0.1:" + port + "/web-realtime");
  try {
    await once(socket, "open");
    expect(mock.realtime).toHaveBeenCalledOnce();
  } finally {
    socket.terminate();
  }
});

test.each(["https://attacker.example", "null"])(
  "rejects trusted WebSocket Host with Origin %s before realtime dispatch",
  async (origin) => {
    const socket = new WebSocket("ws://127.0.0.1:" + port + "/web-realtime", {
      origin,
    });
    try {
      await expect(once(socket, "open")).rejects.toThrow();
      expect(mock.realtime).not.toHaveBeenCalled();
    } finally {
      socket.terminate();
    }
  },
);

test("preserves exact same-origin browser WebSocket access", async () => {
  const socket = new WebSocket("ws://127.0.0.1:" + port + "/web-realtime", {
    origin: "http://127.0.0.1:" + port,
  });
  try {
    await once(socket, "open");
    expect(mock.realtime).toHaveBeenCalledOnce();
  } finally {
    socket.terminate();
  }
});
