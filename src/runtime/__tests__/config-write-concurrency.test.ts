import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as dashboard from "../../web-ui/config-dashboard-backend.js";
import * as validation from "../../web-ui/local-runtime/model-setup-validation.js";
import { setRuntimePluginEnabled } from "../../web-ui/plugin-management-service.js";
import { createFileLongTermMemoryOnboardingConfigRepository } from "../adapters/long-term-memory/onboarding-config-repository.js";
import {
  ConfigFileConflictError,
  withConfigFileTransaction,
} from "../adapters/config-file-transaction.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-review-fixes-20260908/config-writes",
  );
});
afterEach(async () => {
  await fixture.cleanup();
});

function barrier() {
  let resume!: () => void;
  let arrive!: () => void;
  return {
    waiting: new Promise<void>((done) => {
      arrive = done;
    }),
    released: new Promise<void>((done) => {
      resume = done;
    }),
    arrive: () => arrive(),
    resume: () => resume(),
  };
}
const addition = () =>
  fixture.service.add({
    profileId: "added",
    providerId: "ollama",
    model: "fixture-added",
  });
const plugin = (configPath = fixture.configPath) =>
  setRuntimePluginEnabled(
    { rootDir: fixture.rootDir, configPath },
    { pluginId: "system-probe", enabled: false },
  );
const repository = () =>
  createFileLongTermMemoryOnboardingConfigRepository({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
  });

async function pauseModelValidation() {
  const gate = barrier();
  const validate = validation.validateModelAddition;
  vi.spyOn(validation, "validateModelAddition").mockImplementationOnce(
    async (...args) => {
      await validate(...args);
      gate.arrive();
      await gate.released;
    },
  );
  const pending = addition();
  await gate.waiting;
  return { gate, pending };
}

describe("shared config writer transactions", () => {
  test("a plugin writer through an alias waits for model read-modify-write and retains both changes", async () => {
    const alias = join(fixture.rootDir, "config-alias.json");
    await symlink(fixture.configPath, alias);
    const { gate, pending } = await pauseModelValidation();
    const toggled = plugin(alias);
    gate.resume();
    await Promise.all([pending, toggled]);
    const current = await fixture.readConfig();
    expect((await fixture.readModelProfile("added")).model).toBe(
      "fixture-added",
    );
    expect(current.plugins).toMatchObject({ deny: ["system-probe"] });
  });

  test("a model writer waits for a plugin candidate and preserves its committed selection", async () => {
    const gate = barrier();
    const save = dashboard.saveConfigDashboardFile;
    vi.spyOn(dashboard, "saveConfigDashboardFile").mockImplementationOnce(
      async (params) => {
        gate.arrive();
        await gate.released;
        return save(params);
      },
    );
    const toggled = plugin();
    await gate.waiting;
    const added = addition();
    gate.resume();
    await Promise.all([toggled, added]);
    const current = await fixture.readConfig();
    expect((await fixture.readModelProfile("added")).model).toBe(
      "fixture-added",
    );
    expect(current.plugins).toMatchObject({ deny: ["system-probe"] });
  });

  test("a memory probe snapshot conflicts after a model commit and cannot discard that model", async () => {
    const memory = repository();
    const snapshot = await memory.read();
    const { gate, pending } = await pauseModelValidation();
    const written = memory.write(
      { ...snapshot.config, longTermMemory: { enabled: false } },
      snapshot.config,
    );
    const rejected = expect(written).rejects.toThrow(
      "long_term_memory_config_changed",
    );
    gate.resume();
    await pending;
    await rejected;
    expect((await fixture.readConfig()).models.profiles.added).toBeDefined();
  });

  test("a model merge after a memory commit preserves the saved memory settings", async () => {
    const memory = repository();
    const snapshot = await memory.read();
    await memory.write(
      { ...snapshot.config, longTermMemory: { enabled: false } },
      snapshot.config,
    );
    await addition();
    expect((await fixture.readConfig()).longTermMemory).toEqual({
      enabled: false,
    });
  });

  test("rejects an external edit after the model read without leaking or overwriting it", async () => {
    const { gate, pending } = await pauseModelValidation();
    const changed = {
      ...(await fixture.readConfig()),
      webUi: { openOnRuntimeServiceStart: true },
    };
    await fixture.writeConfig(changed);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "config_changed",
      statusCode: 409,
    });
    gate.resume();
    await rejected;
    expect(await fixture.readConfig()).toEqual(changed);
  });

  test("serializes dashboard inline merges and rejects stale root and inline revisions", async () => {
    await addition();
    const legacy = await fixture.readConfig();
    legacy.models.profiles.added = await fixture.readModelProfile("added");
    await fixture.writeConfig(legacy);
    const options = {
      rootDir: fixture.rootDir,
      configPath: fixture.configPath,
    };
    const old = await dashboard.getConfigDashboardSnapshot(options);
    const inline = old.files.models.find((model) => model.id === "added")!;
    expect(inline.revision).toBe(old.files.runtime.revision);
    await plugin();
    for (const file of [old.files.runtime, inline]) {
      await expect(
        dashboard.saveConfigDashboardFile({
          ...options,
          kind: file.kind,
          id: file.id,
          config: file.config,
          expectedRevision: file.revision,
        }),
      ).rejects.toBeInstanceOf(ConfigFileConflictError);
    }
    expect((await fixture.readConfig()).plugins).toMatchObject({
      deny: ["system-probe"],
    });
    const fresh = await dashboard.getConfigDashboardSnapshot(options);
    const model = fresh.files.models.find((entry) => entry.id === "added")!;
    const saved = await dashboard.saveConfigDashboardFile({
      ...options,
      kind: "model",
      id: "added",
      config: { ...model.config, contextWindowTokens: 65536 },
      expectedRevision: model.revision,
    });
    expect(saved.file.revision).not.toBe(model.revision);
    expect((await fixture.readConfig()).plugins).toMatchObject({
      deny: ["system-probe"],
    });
  });

  test("releases the shared lock and removes temporary files after a failed transaction", async () => {
    await expect(
      withConfigFileTransaction(fixture.configPath, async () => {
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");
    await plugin();
    const files = await readdir(join(fixture.rootDir, "local"));
    expect(
      files.some(
        (name) => name.endsWith(".tmp") || name.endsWith(".config.lock"),
      ),
    ).toBe(false);
  });
});
