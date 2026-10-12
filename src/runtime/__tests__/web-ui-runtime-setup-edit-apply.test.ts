import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LocalRuntimeWebBackend } from "../../web-ui/local-runtime-backend.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { recoverRuntimeSetupEdit } from "../../web-ui/local-runtime/runtime-setup-edit-recovery.js";
import {
  createSetupEditFixture,
  type SetupEditFixture,
} from "./support/setup-edit-transaction-fixture.js";

vi.mock("node:fs/promises", async () => ({
  ...(await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  )),
}));
let fixture: SetupEditFixture;
let backend: LocalRuntimeWebBackend | undefined;
let server: Server | undefined;
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("LLM_RUNTIME_CONFIG_FILE", "");
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await backend?.stop();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (fixture) await fs.rm(fixture.workspace, { recursive: true, force: true });
});

test("HTTP Apply returns an actionable conflict while a journal is unresolved, then resumes after recovery", async () => {
  fixture = await createSetupEditFixture();
  backend = new LocalRuntimeWebBackend({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
  });
  const apply = vi
    .spyOn(RuntimeEnvironmentRegistry.prototype, "applyConfiguration")
    .mockResolvedValue({ status: "ready" });
  const { boundaries } = await fixture.capture();
  await fixture.restoreState(boundaries[1].state);
  server = createServer((req, res) => {
    void backend!.handleHttp(
      req,
      res,
      new URL(req.url!, "http://localhost").pathname,
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture-address");
  const origin = `http://127.0.0.1:${address.port}`;
  const requestApply = () =>
    fetch(origin + "/web-api/runtime/config/apply", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });
  const blocked = await requestApply();
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({
    error: "setup_edit_recovery_required",
  });
  expect(apply).not.toHaveBeenCalled();
  expect((await fetch(origin + "/web-api/health")).status).toBe(200);
  await recoverRuntimeSetupEdit(fixture.rootDir);
  const resumed = await requestApply();
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({
    activation: { status: "ready" },
  });
  expect(apply).toHaveBeenCalledOnce();
});
