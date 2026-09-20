import { vi } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createLocalRuntimeApplication,
  type LocalRuntimeApplication,
} from "../../local-application.js";
import type { RuntimeConfig } from "../../ports.js";
import type { RuntimeSetupActivation } from "../../../web-ui/local-runtime/runtime-setup-input.js";
import { RuntimeEnvironmentRegistry } from "../../../web-ui/local-runtime/environment-registry.js";
import { resolveWebUiEnvironmentConfig } from "../../../web-ui/environment-config.js";
import { createModelSetupFixture } from "./model-setup-fixture.js";

export function applyBarrier<T = void>() {
  let release!: (value: T) => void;
  const waiting = new Promise<T>((done) => {
    release = done;
  });
  return { waiting, release };
}

function application(config: RuntimeConfig) {
  let closed = false;
  return {
    services: { config },
    start: vi.fn(async () => {
      if (closed) throw new Error("local_runtime_stopped");
    }),
    stop: vi.fn(async () => {
      closed = true;
    }),
    stopIfIdle: vi.fn(async () => {
      closed = true;
      return true;
    }),
    isOwnerIdle: () => !closed,
    getOwnership: () => (closed ? undefined : ("owner" as const)),
    subscribeScheduledEvents: vi.fn(),
  };
}

export async function createApplyFixture(artifactDirectory?: string) {
  const fixture = await createModelSetupFixture(
    artifactDirectory ?? ".codex/artifacts/pr71-apply-recovery-20260908/apply",
  );
  const owners: ReturnType<typeof application>[] = [];
  vi.mocked(createLocalRuntimeApplication).mockImplementation((config) => {
    const owner = application(config!);
    owners.push(owner);
    return owner as unknown as LocalRuntimeApplication;
  });
  const activate = vi.fn(
    async (_configPath: string): Promise<RuntimeSetupActivation> => ({
      status: "ready",
    }),
  );
  const registry = new RuntimeEnvironmentRegistry({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    defaultEnvironmentId: "prod",
    resolveEnvironmentConfig: (configPath) =>
      resolveWebUiEnvironmentConfig({
        rootDir: fixture.rootDir,
        configPath,
      }),
    onRuntimeSetup: activate,
  });
  await registry.start(["prod"]);
  const config = await fixture.readConfig();
  const runnerPath = resolve(
    dirname(fixture.configPath),
    config.requestRunner.configRef,
  );
  return {
    ...fixture,
    registry,
    owners,
    activate,
    runnerPath,
    readRunner: async () => JSON.parse(await readFile(runnerPath, "utf8")),
    async cleanup() {
      await registry.stop();
      await fixture.cleanup();
    },
  };
}
export type ApplyFixture = Awaited<ReturnType<typeof createApplyFixture>>;
