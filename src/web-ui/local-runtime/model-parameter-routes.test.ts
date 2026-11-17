import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { handleModelParameterPreviewRoute } from "./model-parameter-routes.js";

let root = "";
let path = "";
let origin = "";
let server: Server;
const candidate = { modelId: "selected", providers: { local: { type: "llamacpp" } }, models: [{
  id: "selected", provider: "local", model: "generic-fixture", generation: { parameters: { temperature: { mode: "value", value: 0 } } },
}] };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "abot-parameter-route-"));
  path = join(root, "runtime.config.json");
  await writeFile(path, JSON.stringify({ models: { providers: { local: { type: "llamacpp" } }, profiles: {
    selected: { provider: "local", model: "saved-model", contextWindowTokens: 4096 },
  } } }));
  server = createServer((request, response) => {
    void handleModelParameterPreviewRoute({ method: request.method ?? "GET", route: "runtime/config/model-parameters/preview", request, response, rootDir: root, configPath: path });
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(origin, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(body) });
}

test("previews a draft through local configuration without saving or creating artifacts", async () => {
  const before = await readFile(path, "utf8");
  const response = await post(candidate);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const result = await response.json();
  expect(result.presentation.model.parameters.find((field: { key: string }) => field.key === "temperature")).toMatchObject({ value: 0, source: "configuration" });
  expect(await readFile(path, "utf8")).toBe(before);
  expect(await readdir(root)).toEqual(["runtime.config.json"]);
});

test("requires same-origin JSON and rejects methods, paths and unknown model identities", async () => {
  expect((await post(candidate, { origin: "https://other.example" })).status).toBe(403);
  expect((await post(candidate, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await post(candidate, { "content-type": "text/plain" })).status).toBe(415);
  expect((await fetch(origin)).status).toBe(405);
  expect((await post({ ...candidate, configPath: "/private/secret.json" })).status).toBe(400);
  expect((await post({ ...candidate, models: [{ ...candidate.models[0], configRef: "/private/secret.json" }] })).status).toBe(400);
  expect((await post({ ...candidate, modelId: "unregistered" })).status).toBe(400);
  expect((await post({ ...candidate, providers: { local: { type: "llamacpp", baseUrl: "https://other.example" } } })).status).toBe(400);
});

test("bounds candidate request size", async () => {
  const response = await post({ ...candidate, models: [{ ...candidate.models[0], model: "x".repeat(140_000) }] });
  expect(response.status).toBe(400);
});
