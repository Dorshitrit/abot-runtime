import { afterEach, expect, test, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ManagedLlamaServerRoutes } from "../routes.js";
import type { ManagedLlamaServerManager } from "../manager.js";
import { observeRouter, routerReady } from "../observation.js";
import { serverSettings } from "./fixtures.js";
import { presetId } from "../presets.js";
import { resolve } from "node:path";

afterEach(() => vi.unstubAllGlobals());
async function request(action = "", body: unknown = {}, headers = {}, remoteAddress = "127.0.0.1") {
  const manager = { observe: vi.fn(async () => {}), status: () => ({ phase: "stopped", settings: null }),
    configure: vi.fn(async () => {}), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), install: vi.fn(async () => {}), inspect: vi.fn(async () => {}) };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  Object.assign(req, { headers: { host: "127.0.0.1:5177", origin: "http://127.0.0.1:5177", "content-type": "application/json", ...headers },
    socket: { remoteAddress, localAddress: "127.0.0.1", localPort: 5177 } });
  const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn(), writeHead: (code: number) => { response.statusCode = code; } };
  await new ManagedLlamaServerRoutes(manager as unknown as ManagedLlamaServerManager).handle({ method: action ? "POST" : "GET",
    route: "runtime/managed-llama/server" + (action ? "/" + action : ""), request: req, response: response as unknown as ServerResponse });
  return { manager, code: response.statusCode, body: JSON.parse(response.end.mock.calls[0]![0]) };
}
test("GET only observes status; configure preserves revision and does not start", async () => {
  const read = await request(); expect(read.code).toBe(200); expect(read.manager.observe).toHaveBeenCalledOnce();
  expect(read.manager.start).not.toHaveBeenCalled();
  const body = { settings: serverSettings(resolve("synthetic")), revision: null }, saved = await request("configure", body);
  expect(saved.code).toBe(200); expect(saved.manager.configure).toHaveBeenCalledExactlyOnceWith(body.settings, null);
  expect(saved.manager.start).not.toHaveBeenCalled();
});
test.each([
  [{ origin: "http://evil.invalid" }, "127.0.0.1"],
  [{ "sec-fetch-site": "cross-site" }, "127.0.0.1"],
  [{}, "192.0.2.1"],
  [{ host: "evil.invalid:5177" }, "127.0.0.1"],
] as const)("server mutations reject a nonlocal or cross-origin request", async (headers, remote) => {
  const result = await request("start", {}, headers, remote);
  expect(result.code).toBe(403); expect(result.manager.start).not.toHaveBeenCalled();
});
test("extra inputs and non-JSON mutations are rejected without action", async () => {
  const extra = await request("start", { command: "not allowed" }); expect(extra.code).toBe(400); expect(extra.manager.start).not.toHaveBeenCalled();
  const content = await request("stop", {}, { "content-type": "text/plain" }); expect(content.code).toBe(415); expect(content.manager.stop).not.toHaveBeenCalled();
});
test("router status is bounded and exposes only model states, never upstream paths or arguments", async () => {
  const settings = serverSettings(resolve("synthetic"));
  const fetcher = vi.fn(async (_url: string) => Response.json({ data: [{ id: presetId(settings.models[0]!.alias), path: "private.gguf",
    status: { value: "sleeping", args: ["private-token"] } }] }));
  vi.stubGlobal("fetch", fetcher);
  expect(await observeRouter(18080, "key", settings, new AbortController().signal)).toEqual([{ alias: "chat:one", state: "sleeping" }]);
  expect(fetcher.mock.calls[0]![0]).toBe("http://127.0.0.1:18080/models");
  fetcher.mockResolvedValueOnce(new Response(" ".repeat(1_048_577)));
  await expect(observeRouter(18080, "key", settings, new AbortController().signal)).rejects.toMatchObject({ code: "server_status_unavailable" });
});
test("router readiness rejects unauthenticated endpoints and missing configured models", async () => {
  const settings = serverSettings(resolve("synthetic")), signal = new AbortController().signal;
  const fetcher = vi.fn(async () => Response.json({ data: [] })); vi.stubGlobal("fetch", fetcher);
  expect(await routerReady(18080, "key", settings, signal)).toBe(false);
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(routerReady(18080, "key", settings, signal)).rejects.toMatchObject({ code: "server_catalog_mismatch" });
});
