import type { LookupAllOptions, LookupAddress } from "node:dns";
import * as dns from "node:dns/promises";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeSetupService } from "../../web-ui/local-runtime/runtime-setup-service.js";
import { RuntimeSetupGateway } from "../../web-ui/runtime-setup-gateway.js";
import { processDebugLogger } from "../observability/debug-logger.js";

vi.mock("node:dns/promises", async (original) => {
  const actual = await original<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});
let rootDir = "";
let configPath: string;
let gateway: RuntimeSetupGateway;
let external: Server | undefined;
let gatewayUrl = "";
async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}
beforeEach(async () => {
  const artifactRoot = resolve(
    ".codex/artifacts/onboarding-plugins-1.4-20260908",
  );
  await mkdir(artifactRoot, { recursive: true });
  rootDir = await mkdtemp(join(artifactRoot, "setup-gateway-"));
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise<void>((done) => reservation.close(() => done()));
  gatewayUrl = `http://127.0.0.1:${port}`;
  vi.stubEnv("MODEL_GATEWAY_URL", gatewayUrl);
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
  vi.stubEnv("PORT", "1");
  gateway = new RuntimeSetupGateway({ rootDir });
  let saved: string | undefined;
  const service = new RuntimeSetupService({
    rootDir,
    getConfigPath: () => saved,
    activate: async (path) => {
      saved = path;
      return { status: "restart_required" };
    },
  });
  await service.save({ provider: "ollama", model: "gateway-test" });
  configPath = saved!;
});
afterEach(async () => {
  await gateway.close();
  if (external)
    await new Promise<void>((done) => external!.close(() => done()));
  external = undefined;
  processDebugLogger.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

describe("Web-owned setup model gateway", () => {
  test("starts at the canonical configured address and exposes the saved model without a provider call", async () => {
    expect(await gateway.activate(configPath)).toEqual({ status: "ready" });
    expect(await (await fetch(`${gatewayUrl}/models`)).json()).toMatchObject({
      profiles: [{ model: "gateway-test" }],
    });
  });

  test("preserves an externally owned listener", async () => {
    external = createServer((_req, res) => res.end("external-gateway"));
    await new Promise<void>((done) =>
      external!.listen(Number(new URL(gatewayUrl).port), "127.0.0.1", done),
    );
    expect(await gateway.activate(configPath)).toMatchObject({
      status: "restart_required",
    });
    await gateway.close();
    expect(await (await fetch(gatewayUrl)).text()).toBe("external-gateway");
  });

  test("preserves the running gateway if new configuration fails validation", async () => {
    await gateway.activate(configPath);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.models = {};
    await writeFile(configPath, JSON.stringify(config));
    await expect(gateway.activate(configPath)).rejects.toThrow();
    expect(await (await fetch(`${gatewayUrl}/models`)).json()).toMatchObject({
      profiles: [{ model: "gateway-test" }],
    });
  });
});

test("localhost binds and remains reachable through the configured client hostname", async () => {
  const listenGateway = vi.spyOn(Server.prototype, "listen");
  gatewayUrl = gatewayUrl.replace("127.0.0.1", "localhost");
  vi.stubEnv("MODEL_GATEWAY_URL", gatewayUrl);
  expect(await gateway.activate(configPath)).toEqual({ status: "ready" });
  expect(listenGateway).toHaveBeenCalledWith(
    Number(new URL(gatewayUrl).port),
    "localhost",
    expect.any(Function),
  );
  expect(await (await fetch(`${gatewayUrl}/models`)).json()).toMatchObject({
    profiles: [{ model: "gateway-test" }],
  });
});

test.each(["localhost", "[::1]"])(
  "recognizes an external IPv6 gateway addressed as %s",
  async (host) => {
    external = createServer((_req, res) => res.end("external-ipv6"));
    await new Promise<void>((done, reject) => {
      external!.once("error", reject);
      external!.listen(0, "::1", done);
    });
    const port = (external.address() as AddressInfo).port;
    gatewayUrl = `http://${host}:${port}`;
    vi.stubEnv("MODEL_GATEWAY_URL", gatewayUrl);
    // The test host need not map localhost to IPv6; emulate a dual-stack DNS result.
    if (host === "localhost")
      vi.mocked<
        (host: string, options: LookupAllOptions) => Promise<LookupAddress[]>
      >(dns.lookup).mockResolvedValueOnce([
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ]);
    expect(await gateway.activate(configPath)).toMatchObject({
      status: "restart_required",
    });
    await gateway.close();
    expect(await (await fetch(`http://[::1]:${port}`)).text()).toBe(
      "external-ipv6",
    );
  },
);

test("an owned gateway can be reapplied through a hostname alias at the same port", async () => {
  expect(await gateway.activate(configPath)).toEqual({ status: "ready" });
  gatewayUrl = gatewayUrl.replace("127.0.0.1", "localhost");
  vi.stubEnv("MODEL_GATEWAY_URL", gatewayUrl);
  expect(await gateway.activate(configPath)).toEqual({ status: "ready" });
  expect(await (await fetch(`${gatewayUrl}/models`)).json()).toMatchObject({
    profiles: [{ model: "gateway-test" }],
  });
});
