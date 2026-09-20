import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { startWebUiServer } from "../../web-ui/server.js";
import { renderCompanionInstaller } from "../../web-ui/system-host-setup/installers.js";

const mock = vi.hoisted(() => ({
  server: undefined as Server | undefined,
  container: true,
  platform: "linux" as NodeJS.Platform,
  kernel: "microsoft-standard-WSL2",
  realtime: vi.fn(),
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
vi.mock(
  "../../../plugins/system/source/host-observation.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../../plugins/system/source/host-observation.js")
      >();
    return {
      ...actual,
      readSystemHostFacts: () => ({
        platform: mock.platform,
        kernelRelease: mock.kernel,
        containerMarker: mock.container,
      }),
    };
  },
);
vi.mock("../../web-ui/local-runtime-backend.js", () => ({
  LocalRuntimeWebBackend: class {
    start = async () => {};
    stop = async () => {};
    handleRealtimeConnection = mock.realtime;
    environmentConfig = () => ({
      defaultEnvironmentId: "prod",
      environments: [],
    });
  },
}));
vi.mock("../../web-ui/system-host-setup/companion-bundle.js", () => ({
  readInstallerCompanionBundle: async () =>
    Buffer.from("fixture companion bundle"),
}));
vi.mock("../../web-ui/system-host-setup/installers.js", () => ({
  renderCompanionInstaller: vi.fn(async () => ({
    filename: "setup.cmd",
    mimeType: "application/octet-stream",
    contentBase64: "Zml4dHVyZQ==",
  })),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mock.container = true;
  mock.platform = "linux";
  mock.kernel = "microsoft-standard-WSL2";
});

async function fixture(listenHost = "0.0.0.0", trustedPublish = "1") {
  vi.stubEnv("ABOT_WEB_TRUST_LOOPBACK_PUBLISH", trustedPublish);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const rootDir = await mkdtemp(join(tmpdir(), "abot-docker-authority-"));
  const appDir = join(rootDir, "app");
  await mkdir(appDir);
  await writeFile(
    join(appDir, "index.html"),
    '<script src="/app.js"></script>',
  );
  await writeFile(join(appDir, "app.js"), "window.fixture = true;");
  const handle = startWebUiServer({
    host: listenHost,
    port: 0,
    backend: "runtime",
    rootDir,
    appDir,
  });
  const server = mock.server!;
  if (!server.listening) await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  let duplicateHost = false;
  const forward = (incoming: IncomingMessage) => {
    Object.defineProperty(incoming.socket, "localAddress", {
      value: "172.17.0.2",
    });
    Object.defineProperty(incoming.socket, "localPort", { value: 5177 });
    if (duplicateHost)
      incoming.rawHeaders.push("Host", "attacker.example:5184");
  };
  server.prependListener("request", forward);
  server.prependListener("upgrade", forward);
  cleanups.push(async () => {
    await handle.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  const send = (
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ) =>
    new Promise<{
      status: number;
      text: string;
      headers: IncomingMessage["headers"];
    }>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          agent: false,
          method: body === undefined ? "GET" : "POST",
          headers: {
            host: "localhost:5184",
            "content-type": "application/json",
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              text: Buffer.concat(chunks).toString(),
              headers: response.headers,
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const setup = (headers: Record<string, string> = {}) =>
    send(
      "/web-api/runtime/system-host/setup",
      {
        origin: "http://localhost:5184",
        "sec-fetch-site": "same-origin",
        ...headers,
      },
      { platform: "windows" },
    );
  const upgrade = async (
    headers: Record<string, string> = {},
    includeOrigin = true,
  ) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/web-realtime`, {
      headers: {
        host: "localhost:5184",
        ...(includeOrigin ? { origin: "http://localhost:5184" } : {}),
        ...headers,
      },
    });
    try {
      await once(socket, "open");
      return true;
    } catch {
      return false;
    } finally {
      socket.terminate();
    }
  };
  return {
    send,
    setup,
    upgrade,
    duplicateHost: () => {
      duplicateHost = true;
    },
  };
}

test("serves the complete GUI and setup bundle through Docker's published loopback origin", async () => {
  const f = await fixture();
  expect(await f.send("/")).toMatchObject({
    status: 200,
    text: '<script src="/app.js"></script>',
  });
  expect(await f.send("/app.js")).toMatchObject({
    status: 200,
    text: "window.fixture = true;",
  });
  const config = await f.send("/web-config");
  expect(config.status).toBe(200);
  expect(JSON.parse(config.text)).toMatchObject({
    backend: "runtime",
    apiBasePath: "/web-api",
  });
  const status = await f.send("/web-api/runtime/system-host");
  expect(status.status).toBe(200);
  expect(JSON.parse(status.text).readiness.environment).toBe("container");
  expect((await f.setup()).status).toBe(200);
  const installer = vi.mocked(renderCompanionInstaller).mock.calls.at(-1)![0];
  expect(installer.url).toBe("http://localhost:5184");
  const bundle = await f.send("/web-api/runtime/system-host/bundle", {
    authorization: `Bearer ${installer.code}`,
  });
  expect(bundle).toMatchObject({
    status: 200,
    text: "fixture companion bundle",
  });
  expect(bundle.headers["cache-control"]).toBe("no-store");
  expect(await f.upgrade()).toBe(true);
  expect(mock.realtime).toHaveBeenCalledOnce();
});
test.each(["", "0", "false", "true"])(
  "rejects spoofed loopback HTTP and realtime without explicit publish trust (%j)",
  async (setting) => {
    const f = await fixture("0.0.0.0", setting);
    expect((await f.send("/web-config")).status).toBe(403);
    expect(
      (await f.send("/web-api/runtime/config", {}, { profile: "spoofed" }))
        .status,
    ).toBe(403);
    expect((await f.setup()).status).toBe(403);
    expect(await f.upgrade({}, false)).toBe(false);
    expect(mock.realtime).not.toHaveBeenCalled();
    expect(renderCompanionInstaller).not.toHaveBeenCalled();
  },
);
test.each(["abot-qa.localhost:5184", "127.0.0.1:5184", "[::1]:5184"])(
  "accepts only canonical published loopback authority %s",
  async (host) => {
    const f = await fixture();
    expect((await f.send("/web-config", { host })).status).toBe(200);
    expect(await f.upgrade({ host, origin: `http://${host}` })).toBe(true);
  },
);
test.each<Record<string, string>>([
  {
    host: "attacker.example:5184",
    origin: "http://attacker.example:5184",
    "x-forwarded-host": "localhost:5184",
  },
  { host: "localhost.attacker.example:5184" },
  { host: "localhost:5184/path" },
  { host: "192.168.1.99:5184", forwarded: "host=localhost:5184" },
])("rejects hostile or malformed forwarded authority %j", async (headers) => {
  const f = await fixture();
  expect((await f.send("/web-config", headers)).status).toBe(403);
  expect((await f.setup(headers)).status).toBe(403);
  expect(await f.upgrade(headers)).toBe(false);
  expect(renderCompanionInstaller).not.toHaveBeenCalled();
});
test("rejects duplicate Host headers before HTTP or realtime dispatch", async () => {
  const f = await fixture();
  f.duplicateHost();
  expect((await f.send("/web-config")).status).toBe(403);
  expect(await f.upgrade()).toBe(false);
});
test.each<Record<string, string>>([
  { origin: "http://attacker.example:5184" },
  { origin: "http://localhost:5185" },
  { origin: "null" },
  { origin: "http://localhost:5184", "sec-fetch-site": "cross-site" },
])(
  "keeps same-origin setup requirements for forwarded Host %j",
  async (headers) => {
    const f = await fixture();
    expect((await f.setup(headers)).status).toBe(403);
    expect(renderCompanionInstaller).not.toHaveBeenCalled();
    if (headers.origin !== "http://localhost:5184")
      expect(await f.upgrade(headers)).toBe(false);
  },
);
test("bundle requests retain native-only bearer authorization", async () => {
  const f = await fixture();
  expect((await f.setup()).status).toBe(200);
  const code = vi.mocked(renderCompanionInstaller).mock.calls.at(-1)![0].code;
  const path = "/web-api/runtime/system-host/bundle";
  expect((await f.send(path)).status).toBe(401);
  expect(
    (await f.send(path, { authorization: `Bearer ${"a".repeat(43)}` })).status,
  ).toBe(401);
  expect(
    (
      await f.send(path, {
        authorization: `Bearer ${code}`,
        origin: "http://localhost:5184",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.send(path, {
        authorization: `Bearer ${code}`,
        "sec-fetch-site": "none",
      })
    ).status,
  ).toBe(401);
});
test.each(["native", "wsl", "non-linux", "specific-listener"])(
  "does not introduce forwarded authority in %s environments",
  async (kind) => {
    mock.container = !["native", "wsl"].includes(kind);
    mock.platform = kind === "non-linux" ? "darwin" : "linux";
    mock.kernel = kind === "wsl" ? "microsoft-standard-WSL2" : "linux";
    const f = await fixture(
      kind === "specific-listener" ? "127.0.0.1" : "0.0.0.0",
    );
    expect((await f.send("/web-config")).status).toBe(403);
    expect(await f.upgrade()).toBe(false);
  },
);
