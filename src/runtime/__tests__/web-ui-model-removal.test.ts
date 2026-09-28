import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import { withConfigFileTransaction } from "../adapters/config-file-transaction.js";
import { getConfigDashboardSnapshot } from "../../web-ui/config-dashboard-backend.js";
import { removeRuntimeModelDeclaration } from "../../web-ui/local-runtime/model-removal.js";
import * as modelValidation from "../../web-ui/local-runtime/model-setup-validation.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/model-config-lifecycle-20260923/removal",
  );
});
afterEach(async () => fixture.cleanup());
const options = () => ({
  rootDir: fixture.rootDir,
  configPath: fixture.configPath,
});
async function revision() {
  return (await getConfigDashboardSnapshot(options())).files.runtime.revision;
}
function remove(body: Record<string, unknown>) {
  return withConfigFileTransaction(fixture.configPath, (transaction) =>
    removeRuntimeModelDeclaration(options(), transaction, body),
  );
}
async function addDeclaration(id: string, referenced = false) {
  const config = await fixture.readConfig();
  const profile = JSON.parse(
    await readFile(
      join(fixture.rootDir, "local/models/default.config.json"),
      "utf8",
    ),
  );
  profile.model = id;
  if (referenced) {
    await writeFile(
      join(fixture.rootDir, `local/models/${id}.config.json`),
      JSON.stringify(profile),
    );
    config.models.profiles[id] = { configRef: `./models/${id}.config.json` };
  } else config.models.profiles[id] = profile;
  await fixture.writeConfig(config);
}

describe("soft model declaration removal", () => {
  test.each([false, true])(
    "removes a declared model, preserves providers and files (referenced=%s)",
    async (referenced) => {
      await addDeclaration("extra", referenced);
      const before = await fixture.readConfig();
      const env = await fixture.readEnv();
      const path = join(
        fixture.rootDir,
        referenced
          ? "local/models/extra.config.json"
          : "local/models/default.config.json",
      );
      const profileBytes = await readFile(path, "utf8");
      const dashboard = await getConfigDashboardSnapshot(options());
      expect(
        dashboard.files.models.find((model) => model.id === "extra")
          ?.registered,
      ).toBe(true);
      await expect(
        remove({
          profileId: "extra",
          expectedRevision: dashboard.files.runtime.revision,
        }),
      ).resolves.toEqual({ profileId: "extra", restartRequired: true });
      delete before.models.profiles.extra;
      expect(await fixture.readConfig()).toEqual(before);
      expect(await fixture.readEnv()).toBe(env);
      expect(await readFile(path, "utf8")).toBe(profileBytes);
      const after = await getConfigDashboardSnapshot(options());
      const extra = after.files.models.find((model) => model.id === "extra");
      if (referenced)
        expect(extra).toMatchObject({
          registered: false,
          path: "local/models/extra.config.json",
        });
      else expect(extra).toBeUndefined();
    },
  );

  test("preserves a prior public distribution model file and reference when removing an unused model", async () => {
    await addDeclaration("unused");
    const legacyBytes = await readFile(
      new URL(
        "./fixtures/public-v1.0.0/models/default.config.json",
        import.meta.url,
      ),
    );
    const legacyPath = join(
      fixture.rootDir,
      "local/models/default.config.json",
    );
    await writeFile(legacyPath, legacyBytes);
    const config = await fixture.readConfig();
    config.models.providers.provider = { ...config.models.providers.ollama };
    await fixture.writeConfig(config);
    const expectedRef = structuredClone(config.models.profiles.default);
    const expectedProviders = structuredClone(config.models.providers);
    await remove({ profileId: "unused", expectedRevision: await revision() });
    const saved = await fixture.readConfig();
    expect(saved.models.profiles).toEqual({ default: expectedRef });
    expect(saved.models.providers).toEqual(expectedProviders);
    expect(await readFile(legacyPath)).toEqual(legacyBytes);
    const loaded = loadRuntimeConfig({ ...options(), env: { ...process.env } });
    expect(loaded.models?.profiles?.default).toMatchObject({
      provider: "provider",
      model: "replace-with-model-id",
      contextWindowTokens: 32768,
    });
    expect(Object.keys(loaded.models?.profiles ?? {})).toEqual(["default"]);
  });

  test("rejects removal of a default model without changing configuration", async () => {
    await addDeclaration("extra");
    const before = await readFile(fixture.configPath, "utf8");
    await expect(
      remove({ profileId: "default", expectedRevision: await revision() }),
    ).rejects.toMatchObject({
      code: "model_removal_invalid_config",
      statusCode: 409,
      message: expect.stringContaining(
        "requestRunner.models.defaults.profileId",
      ),
    });
    expect(await readFile(fixture.configPath, "utf8")).toBe(before);
  });

  test.each(["role", "invocation", "calibration"])(
    "rejects dangling %s references without selecting a replacement",
    async (reference) => {
      await addDeclaration("extra");
      const config = await fixture.readConfig();
      if (reference === "role")
        config.models.defaults = { roles: { worker: "extra" } };
      if (reference === "invocation")
        config.models.invocationProfiles = { custom: { profileId: "extra" } };
      if (reference === "calibration") {
        await addDeclaration("other");
        config.models.profiles.other = (
          await fixture.readConfig()
        ).models.profiles.other;
        config.models.profiles.other.calibration = {
          "worker.decision": { profileId: "extra" },
        };
      }
      await fixture.writeConfig(config);
      await expect(
        remove({ profileId: "extra", expectedRevision: await revision() }),
      ).rejects.toMatchObject({
        code: "model_removal_invalid_config",
        message: expect.stringContaining("unknown model"),
      });
      expect(await fixture.readConfig()).toEqual(config);
    },
  );

  test("reports unrelated validation issues accurately and preserves the declaration", async () => {
    await addDeclaration("extra");
    const config = await fixture.readConfig();
    config.unsupported = true;
    await fixture.writeConfig(config);
    await expect(
      remove({ profileId: "extra", expectedRevision: await revision() }),
    ).rejects.toMatchObject({
      code: "model_removal_invalid_config",
      message: expect.stringContaining("unsupported is not a supported"),
    });
    expect(await fixture.readConfig()).toEqual(config);
  });

  test("requires root revision and rejects stale configuration before removal", async () => {
    await addDeclaration("extra", true);
    const dashboard = await getConfigDashboardSnapshot(options());
    const linkedRevision = dashboard.files.models.find(
      (model) => model.id === "extra",
    )!.revision;
    await expect(remove({ profileId: "extra" })).rejects.toMatchObject({
      statusCode: 428,
    });
    await expect(
      remove({ profileId: "extra", expectedRevision: linkedRevision }),
    ).rejects.toMatchObject({ code: "config_changed" });
    const config = await fixture.readConfig();
    config.logging = { enabled: false };
    await fixture.writeConfig(config);
    await expect(
      remove({
        profileId: "extra",
        expectedRevision: dashboard.files.runtime.revision,
      }),
    ).rejects.toMatchObject({ code: "config_changed" });
    expect(await fixture.readConfig()).toEqual(config);
  });

  test("serializes removal requests without accepting a second stale write", async () => {
    await addDeclaration("first");
    await addDeclaration("second");
    const expectedRevision = await revision();
    const results = await Promise.allSettled([
      remove({ profileId: "first", expectedRevision }),
      remove({ profileId: "second", expectedRevision }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "config_changed" } });
    expect(
      Object.keys((await fixture.readConfig()).models.profiles),
    ).toHaveLength(2);
  });

  test.each([false, true])(
    "checks the selected config symlink after validation (retargeted=%s)",
    async (retargeted) => {
      await addDeclaration("extra");
      const expectedRevision = await revision();
      const before = await readFile(fixture.configPath, "utf8");
      const selectedPath = join(fixture.rootDir, "local/selected.config.json");
      const replacementPath = join(
        fixture.rootDir,
        "local/replacement.config.json",
      );
      await writeFile(replacementPath, before);
      await symlink(fixture.configPath, selectedPath);
      const validate = modelValidation.validateModelConfigurationChange;
      vi.spyOn(
        modelValidation,
        "validateModelConfigurationChange",
      ).mockImplementationOnce(
        async (candidate, selectedOptions) => {
          await validate(candidate, selectedOptions);
          if (!retargeted) return;
          await rm(selectedPath);
          await symlink(replacementPath, selectedPath);
        },
      );
      const removal = withConfigFileTransaction(selectedPath, (transaction) =>
        removeRuntimeModelDeclaration(
          { ...options(), configPath: selectedPath },
          transaction,
          { profileId: "extra", expectedRevision },
        ),
      );
      if (retargeted) {
        await expect(removal).rejects.toMatchObject({
          code: "config_changed",
          statusCode: 409,
        });
        expect(await readFile(fixture.configPath, "utf8")).toBe(before);
      } else {
        await expect(removal).resolves.toEqual({
          profileId: "extra",
          restartRequired: true,
        });
        expect(
          (await fixture.readConfig()).models.profiles.extra,
        ).toBeUndefined();
      }
      expect(await readFile(replacementPath, "utf8")).toBe(before);
    },
  );

  test("cannot remove an unregistered file or mutate unsupported fields", async () => {
    await addDeclaration("extra", true);
    await remove({ profileId: "extra", expectedRevision: await revision() });
    const before = await fixture.readConfig();
    await expect(
      remove({ profileId: "extra", expectedRevision: await revision() }),
    ).rejects.toMatchObject({ code: "model_profile_not_registered" });
    await expect(
      remove({
        profileId: "default",
        expectedRevision: await revision(),
        deleteFile: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_model_input" });
    expect(await fixture.readConfig()).toEqual(before);
  });
});
