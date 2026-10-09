import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { createLocalRuntimeApplication } from "../local-application.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import { RuntimeSetupGateway } from "../../web-ui/runtime-setup-gateway.js";
import {
  createApplyFixture,
  type ApplyFixture,
} from "./support/web-ui-apply-fixture.js";

vi.mock("../local-application.js", () => ({
  createLocalRuntimeApplication: vi.fn(),
}));

let fixture: ApplyFixture | undefined;
let registry: RuntimeEnvironmentRegistry | undefined;
let gateway: RuntimeSetupGateway | undefined;
let external: Server | undefined;

afterEach(async () => {
  await registry?.stop();
  await gateway?.close();
  if (external?.listening)
    await new Promise<void>((done) => external!.close(() => done()));
  await fixture?.cleanup();
});

test("an unknown gateway baseline preserves Runtime startup and refuses external reuse", async () => {
  external = createServer((_request, response) => response.end("external"));
  await new Promise<void>((done) => external!.listen(0, "127.0.0.1", done));
  const gatewayUrl = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
  vi.stubEnv("MODEL_GATEWAY_URL", gatewayUrl);
  fixture = await createApplyFixture(
    ".codex/artifacts/plugin-only-activation-20261007/unknown-gateway-snapshot",
  );
  gateway = new RuntimeSetupGateway({ rootDir: fixture.rootDir });
  const capture = vi.fn(() => {
    throw new Error("gateway_configuration_unavailable");
  });
  const check = vi.fn(
    (configPath: string, applied?: readonly (string | null)[]) =>
      gateway!.checkActivation(configPath, applied),
  );
  registry = new RuntimeEnvironmentRegistry({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
    captureRuntimeSetupConfiguration: capture,
    checkRuntimeSetupActivation: check,
    onRuntimeSetup: (configPath, applied) =>
      gateway!.activate(configPath, applied),
  });

  await registry.start(["prod"]);

  const owner = registry.get("prod");
  expect(owner.start).toHaveBeenCalledOnce();
  expect(capture).toHaveBeenCalledOnce();
  expect(vi.mocked(createLocalRuntimeApplication)).toHaveBeenCalledTimes(2);
  await expect(registry.applyConfiguration()).resolves.toMatchObject({
    status: "restart_required",
  });
  expect(check).toHaveBeenCalledWith(fixture.configPath, [null]);
  expect(registry.get("prod")).toBe(owner);
  expect(owner.stopIfIdle).not.toHaveBeenCalled();
  expect(owner.stop).not.toHaveBeenCalled();
  expect(external.listening).toBe(true);
});
