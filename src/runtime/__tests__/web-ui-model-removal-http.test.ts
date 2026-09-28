import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";
import {
  getConfigDashboardSnapshot,
  type ConfigDashboardSnapshot,
} from "../../web-ui/config-dashboard-backend.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import * as modelValidation from "../../web-ui/local-runtime/model-setup-validation.js";
// @ts-expect-error Browser JavaScript has no declaration surface.
import { createModelRemovalController } from "../../web-ui/app/components/config-workspace/model-removal.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
let server: Server;
let backend: LocalRuntimeWebBackend;
let origin: string;
let expectedRevision: string;
const activate = vi.fn(async () => ({ status: "ready" as const }));
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr86-removal-settlement-20260923/removal-http",
  );
  await fixture.service.add({
    profileId: "extra",
    model: "fixture-extra",
    providerId: "ollama",
  });
  expectedRevision = (await getConfigDashboardSnapshot(fixture)).files.runtime
    .revision;
  activate.mockClear();
  backend = new LocalRuntimeWebBackend({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
    onRuntimeSetup: activate,
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
function remove(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return fetch(`${origin}/web-api/runtime/config/models`, {
    method: "DELETE",
    headers: { "content-type": "application/json", origin, ...headers },
    body: JSON.stringify(body),
    signal,
  });
}
test("removal persists the declaration change without activating the runtime", async () => {
  const result = await remove({ profileId: "extra", expectedRevision });
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toMatchObject({
    ok: true,
    profileId: "extra",
    restartRequired: true,
  });
  expect((await fixture.readConfig()).models.profiles.extra).toBeUndefined();
  expect(activate).not.toHaveBeenCalled();
});
test("removal enforces same-origin JSON and fresh root revision", async () => {
  const before = await readFile(fixture.configPath, "utf8");
  const input = { profileId: "extra", expectedRevision };
  expect(
    (await remove(input, { origin: "https://other.example" })).status,
  ).toBe(403);
  expect((await remove(input, { "content-type": "text/plain" })).status).toBe(
    415,
  );
  expect((await remove({ profileId: "extra" })).status).toBe(428);
  expect((await remove({ ...input, expectedRevision: "stale" })).status).toBe(
    409,
  );
  expect(await readFile(fixture.configPath, "utf8")).toBe(before);
});
test("a model needed by the runner reports an actionable validation failure", async () => {
  const result = await remove({ profileId: "default", expectedRevision });
  expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject({
    error: "model_removal_invalid_config",
    message: expect.stringContaining("requestRunner.models.defaults.profileId"),
  });
  expect((await fixture.readConfig()).models.profiles.default).toBeDefined();
});

function gate() {
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, release };
}

test.each([
  { profileId: "extra", committed: true },
  { profileId: "default", committed: false },
])(
  "aborted HTTP removal reconciles only after validation settles ($profileId)",
  async ({ profileId, committed }) => {
    const validationStarted = gate();
    const validationMayFinish = gate();
    const dashboardRequested = gate();
    const validate = modelValidation.validateModelConfigurationChange;
    vi.spyOn(
      modelValidation,
      "validateModelConfigurationChange",
    ).mockImplementationOnce(async (candidate, options) => {
      validationStarted.release();
      await validationMayFinish.entered;
      await validate(candidate, options);
    });
    server.on("request", (req) => {
      if (req.url?.startsWith("/web-api/runtime/config/dashboard"))
        dashboardRequested.release();
    });
    const transport = new AbortController();
    const runtimeClient = createRuntimeWebClient({
      getConfig: () => ({ apiBasePath: `${origin}/web-api` }),
      getEnvironmentId: () => "prod",
      origin,
    });
    const options = {
      removeModel: vi.fn((input: Record<string, unknown>) =>
        remove(input, {}, transport.signal),
      ),
      loadDashboard: vi.fn((environmentId: string) =>
        runtimeClient.loadConfigDashboard(environmentId, { settled: true }),
      ),
      getEnvironmentId: () => "prod",
      beginRuntimeMutation: () => true,
      endRuntimeMutation: vi.fn(),
      refreshRuntimeConfig: vi.fn(async () => true),
      onSaved: vi.fn(),
      setStatus: vi.fn(),
      confirmRemoval: () => true,
    };
    const controller = createModelRemovalController(options);
    const removal: Promise<boolean> = controller.remove({
      profileId,
      expectedRevision,
    });
    try {
      await validationStarted.entered;
      transport.abort();
      await dashboardRequested.entered;
      await expect(
        Promise.race([
          removal.then(() => "completed"),
          setTimeout(100, "pending"),
        ]),
      ).resolves.toBe("pending");
      expect(
        (await fixture.readConfig()).models.profiles[profileId],
      ).toBeDefined();
      expect(options.onSaved).not.toHaveBeenCalled();
      expect(options.setStatus).not.toHaveBeenCalled();
      expect(options.endRuntimeMutation).not.toHaveBeenCalled();
      await expect(
        controller.remove({ profileId, expectedRevision }),
      ).resolves.toBe(false);
      expect(options.removeModel).toHaveBeenCalledOnce();

      validationMayFinish.release();
      await expect(removal).resolves.toBe(committed);
      expect(options.loadDashboard).toHaveBeenCalledExactlyOnceWith("prod");
      const payload = await options.loadDashboard.mock.results[0]!.value;
      const runtime = (payload.dashboard as ConfigDashboardSnapshot).files.runtime;
      const profiles = (
        runtime.config.models as { profiles: Record<string, unknown> }
      ).profiles;
      expect(Object.hasOwn(profiles, profileId)).toBe(!committed);
      expect(runtime.revision === expectedRevision).toBe(!committed);
      expect(options.onSaved).toHaveBeenCalledTimes(committed ? 1 : 0);
      expect(options.refreshRuntimeConfig).toHaveBeenCalledTimes(
        committed ? 1 : 0,
      );
      expect(options.endRuntimeMutation).toHaveBeenCalledOnce();
      expect(activate).not.toHaveBeenCalled();
    } finally {
      validationMayFinish.release();
      await removal;
    }
  },
);
