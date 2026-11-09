import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readConfigFileSnapshot } from "../adapters/config-file-transaction.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
let backend: LocalRuntimeWebBackend;
let server: Server;
let origin: string;
const activate = vi.fn(async () => ({ status: "ready" as const }));

beforeEach(async () => {
  fixture = await createModelSetupFixture(tmpdir());
  const config = await fixture.readConfig();
  config.models.providers.spare = {
    type: "ollama",
    baseUrl: "http://localhost:11434",
  };
  await fixture.writeConfig(config);
  activate.mockClear();
  backend = new LocalRuntimeWebBackend({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
    onRuntimeSetup: activate,
  });
  server = createServer((request, response) => {
    const pathname = new URL(request.url!, "http://localhost").pathname;
    void backend.handleHttp(request, response, pathname);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await backend.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture.cleanup();
});

test("the Web client edits and deletes saved connections using the displayed revision, before Apply", async () => {
  const client = createRuntimeWebClient({
    getConfig: () => ({ apiBasePath: "/web-api" }),
    getEnvironmentId: () => "prod",
    origin,
    fetchImpl: (url, init) => fetch(new URL(String(url), origin), init),
  });
  const expectedRevision = (await readConfigFileSnapshot(fixture.configPath))
    .revision;
  const selected = { providerId: "spare", expectedRevision };
  await expect(
    client.updateRuntimeProvider({ ...selected, keepAlive: "7m" }, "prod"),
  ).resolves.toEqual({ ok: true, providerId: "spare", restartRequired: true });
  expect((await fixture.readConfig()).models.providers.spare.keepAlive).toBe(
    "7m",
  );
  await expect(
    client.removeRuntimeProvider(selected, "prod"),
  ).rejects.toMatchObject({ code: "config_changed", status: 409 });
  const latestRevision = (await readConfigFileSnapshot(fixture.configPath))
    .revision;
  await expect(
    client.removeRuntimeProvider(
      { ...selected, expectedRevision: latestRevision },
      "prod",
    ),
  ).resolves.toEqual({ ok: true, providerId: "spare", restartRequired: true });
  expect((await fixture.readConfig()).models.providers.spare).toBeUndefined();
  expect(activate).not.toHaveBeenCalled();
});

test("provider routes reject unsafe writes and return bounded, private errors", async () => {
  const before = await readConfigFileSnapshot(fixture.configPath);
  const path = origin + "/web-api/runtime/config/providers";
  const headers = { "content-type": "application/json", origin };
  const input = { providerId: "spare", expectedRevision: before.revision };
  const body = JSON.stringify(input);
  expect(
    (
      await fetch(path, {
        method: "DELETE",
        headers: { ...headers, origin: "https://other.example" },
        body,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(path, {
        method: "PUT",
        headers: { ...headers, "content-type": "text/plain" },
        body,
      })
    ).status,
  ).toBe(415);
  expect((await fetch(path, { method: "POST", headers, body })).status).toBe(
    405,
  );
  const credential = "fixture-key-never-echo";
  for (const invalid of [
    JSON.stringify({ ...input, apiKey: credential }),
    JSON.stringify({ ...input, apiKey: credential.repeat(1024) }),
  ]) {
    const response = await fetch(path, {
      method: "PUT",
      headers,
      body: invalid,
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(credential);
  }
  expect((await readConfigFileSnapshot(fixture.configPath)).revision).toBe(
    before.revision,
  );
});
