import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
let server: Server;
let backend: LocalRuntimeWebBackend;
let origin: string;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-review-fixes-20260908/config-http",
  );
  backend = new LocalRuntimeWebBackend({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
  });
  server = createServer((req, res) => {
    void backend.handleHttp(
      req,
      res,
      new URL(req.url!, "http://localhost").pathname,
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await backend.stop();
  await new Promise<void>((done) => server.close(() => done()));
  await fixture.cleanup();
});
function put(body: Record<string, unknown>, requestOrigin = origin) {
  return fetch(`${origin}/web-api/runtime/config/dashboard/file`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: requestOrigin },
    body: JSON.stringify(body),
  });
}
async function dashboard() {
  const response = await fetch(`${origin}/web-api/runtime/config/dashboard`);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()).dashboard;
}

test("an old browser draft conflicts after model addition; refreshed saves use the returned revision", async () => {
  const old = (await dashboard()).files.runtime;
  await fixture.service.add({
    profileId: "second",
    providerId: "ollama",
    model: "fixture-second",
  });
  const stale = await put({
    kind: "runtime",
    config: old.config,
    expectedRevision: old.revision,
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "config_changed" });
  expect((await fixture.readConfig()).models.profiles.second).toBeDefined();
  const fresh = (await dashboard()).files.runtime;
  const candidate = {
    ...fresh.config,
    webUi: { openOnRuntimeServiceStart: true },
  };
  const saved = await put({
    kind: "runtime",
    config: candidate,
    expectedRevision: fresh.revision,
  });
  expect(saved.status).toBe(200);
  const payload = await saved.json();
  expect(payload.file.revision).not.toBe(fresh.revision);
  const resaved = await put({
    kind: "runtime",
    config: { ...candidate, webUi: { openOnRuntimeServiceStart: false } },
    expectedRevision: payload.file.revision,
  });
  expect(resaved.status).toBe(200);
  expect((await fixture.readConfig()).models.profiles.second).toBeDefined();
});

test("missing revisions and cross-origin dashboard writes do not modify configuration", async () => {
  const before = await fixture.readConfig();
  const current = (await dashboard()).files.runtime;
  expect((await put({ kind: "runtime", config: current.config })).status).toBe(
    428,
  );
  expect(
    (
      await put(
        {
          kind: "runtime",
          config: current.config,
          expectedRevision: current.revision,
        },
        "https://other.example",
      )
    ).status,
  ).toBe(403);
  expect(await fixture.readConfig()).toEqual(before);
});

test("inline model revisions cover unrelated root changes made by another browser", async () => {
  await fixture.service.add({
    profileId: "inline",
    providerId: "ollama",
    model: "fixture-inline",
  });
  const first = await dashboard();
  const model = first.files.models.find(
    (item: { id: string }) => item.id === "inline",
  );
  const second = first.files.runtime;
  expect(
    (
      await put({
        kind: "runtime",
        config: {
          ...second.config,
          webUi: { openOnRuntimeServiceStart: true },
        },
        expectedRevision: second.revision,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await put({
        kind: "model",
        id: "inline",
        config: { ...model.config, contextWindowTokens: 65536 },
        expectedRevision: model.revision,
      })
    ).status,
  ).toBe(409);
  expect(
    (await fixture.readConfig()).models.profiles.inline.contextWindowTokens,
  ).toBe(32768);
});
