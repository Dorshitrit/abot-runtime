import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import * as dashboard from "../../web-ui/config-dashboard-backend.js";
import * as provider from "../../web-ui/local-runtime/model-setup-provider.js";
import { ModelSetupService } from "../../web-ui/local-runtime/model-setup-service.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/model-config-lifecycle-20260923/references",
  );
});
afterEach(async () => fixture.cleanup());
const input = {
  profileId: "extra",
  model: "fixture-extra",
  providerId: "ollama",
};
const modelPath = () =>
  join(dirname(fixture.configPath), "models/extra.config.json");

test("a new model uses a linked file and an exact retry does not rewrite either file", async () => {
  const result = await fixture.service.add(input);
  const root = await readFile(fixture.configPath, "utf8");
  const profile = await readFile(modelPath(), "utf8");
  expect((await fixture.readConfig()).models.profiles.extra).toEqual({
    configRef: "./models/extra.config.json",
  });
  expect(JSON.parse(profile)).toMatchObject({
    provider: "ollama",
    model: "fixture-extra",
  });
  expect(await fixture.service.add(input)).toEqual(result);
  expect(await readFile(fixture.configPath, "utf8")).toBe(root);
  expect(await readFile(modelPath(), "utf8")).toBe(profile);
});

test("a config-file symlink in another directory keeps model references relative to its source", async () => {
  const aliasDirectory = join(fixture.rootDir, "selected-config");
  await mkdir(aliasDirectory);
  const config = await fixture.readConfig();
  for (const ref of [
    config.requestRunner.configRef,
    config.models.profiles.default.configRef,
  ]) {
    const target = resolve(aliasDirectory, ref);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(dirname(fixture.configPath), ref), target);
  }
  const alias = join(aliasDirectory, "runtime.config.json");
  await symlink(fixture.configPath, alias);
  const service = new ModelSetupService({
    rootDir: fixture.rootDir,
    getConfigPath: () => alias,
  });

  const result = await service.add(input);
  const sourceModel = resolve(aliasDirectory, "models/extra.config.json");
  expect(JSON.parse(await readFile(sourceModel, "utf8"))).toMatchObject({
    model: "fixture-extra",
  });
  await expect(readFile(modelPath(), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    loadRuntimeConfig({
      rootDir: fixture.rootDir,
      configPath: alias,
      env: { ...process.env },
    }).models?.profiles?.extra?.model,
  ).toBe("fixture-extra");
  expect(await service.add(input)).toEqual(result);
});

test.each([false, true])(
  "a parent-directory link keeps catalog, add and remove references lexical (workspace link=%s)",
  async (linkedWorkspace) => {
    const nestedDirectory = join(fixture.rootDir, "actual/nested");
    const sharedDirectory = join(fixture.rootDir, "shared");
    await mkdir(nestedDirectory, { recursive: true });
    await mkdir(sharedDirectory);
    const config = await fixture.readConfig();
    for (const [declaration, name] of [
      [config.requestRunner, "request-runner.json"],
      [config.models.profiles.default, "default.json"],
    ] as const) {
      await copyFile(
        resolve(dirname(fixture.configPath), declaration.configRef),
        join(sharedDirectory, name),
      );
      declaration.configRef = `../shared/${name}`;
    }
    const target = join(nestedDirectory, "runtime.config.json");
    await writeFile(target, JSON.stringify(config));
    await symlink(nestedDirectory, join(fixture.rootDir, "selected-config"));
    let rootDir = fixture.rootDir;
    if (linkedWorkspace) {
      rootDir = join(fixture.rootDir, "workspace-alias");
      await symlink(fixture.rootDir, rootDir);
    }
    const configPath = join(rootDir, "selected-config/runtime.config.json");
    const options = { rootDir, configPath };
    const service = new ModelSetupService({
      rootDir,
      getConfigPath: () => configPath,
    });
    const load = () =>
      loadRuntimeConfig({ ...options, env: { ...process.env } });
    expect(load().models?.profiles?.default?.model).toBe("fixture-chat");
    expect((await service.catalog()).profileIds).toContain("default");

    await service.add(input);
    expect(load().models?.profiles?.extra?.model).toBe("fixture-extra");
    const saved = JSON.parse(await readFile(target, "utf8"));
    expect(saved.models.profiles.default).toEqual(
      config.models.profiles.default,
    );
    expect(saved.models.profiles.extra).toEqual({
      configRef: "./models/extra.config.json",
    });
    const profile = join(nestedDirectory, "models/extra.config.json");
    const profileBytes = await readFile(profile, "utf8");
    const snapshot = await dashboard.getConfigDashboardSnapshot(options);
    await expect(
      service.remove({
        profileId: "extra",
        expectedRevision: snapshot.files.runtime.revision,
      }),
    ).resolves.toMatchObject({ profileId: "extra", restartRequired: true });
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(config);
    expect(await readFile(profile, "utf8")).toBe(profileBytes);
    expect(load().models?.profiles?.extra).toBeUndefined();
    expect((await service.catalog()).profileIds).toEqual(["default"]);
  },
);

test("an exact unregistered profile file is adopted without being rewritten", async () => {
  await fixture.service.add(input);
  const profileBytes = await readFile(modelPath(), "utf8");
  const config = await fixture.readConfig();
  delete config.models.profiles.extra;
  await fixture.writeConfig(config);
  expect((await fixture.service.catalog()).profileIds).not.toContain("extra");

  const result = await fixture.service.add(input);
  expect(result.model.profileId).toBe("extra");
  expect((await fixture.readConfig()).models.profiles.extra).toEqual({
    configRef: "./models/extra.config.json",
  });
  expect(await readFile(modelPath(), "utf8")).toBe(profileBytes);
});

test("an external edit during orphan adoption preserves the child and rejects the root save", async () => {
  await fixture.service.add(input);
  const config = await fixture.readConfig();
  delete config.models.profiles.extra;
  await fixture.writeConfig(config);
  const rootBytes = await readFile(fixture.configPath, "utf8");
  const external = '{"model":"external-edit"}\n';
  const saveCredential = provider.saveModelCredential;
  vi.spyOn(provider, "saveModelCredential").mockImplementationOnce(
    async (...args) => {
      await writeFile(modelPath(), external);
      return saveCredential(...args);
    },
  );

  await expect(fixture.service.add(input)).rejects.toMatchObject({
    code: "config_changed",
  });
  expect(await readFile(fixture.configPath, "utf8")).toBe(rootBytes);
  expect(await readFile(modelPath(), "utf8")).toBe(external);
});

test("a changed orphan after credential persistence reports the saved key", async () => {
  const cloudInput = {
    profileId: "cloud",
    model: "fixture-cloud",
    newProvider: { id: "cloud", type: "openai" as const },
    apiKey: "fixture-private-key",
  };
  const originalConfig = await fixture.readConfig();
  await fixture.service.add(cloudInput);
  const saved = await fixture.readConfig();
  const credentialName = saved.models.providers.cloud.apiKeyEnv;
  await fixture.writeConfig(originalConfig);
  await writeFile(fixture.envPath, "");
  delete process.env[credentialName];
  const rootBytes = await readFile(fixture.configPath, "utf8");
  const childPath = join(
    dirname(fixture.configPath),
    "models/cloud.config.json",
  );
  const external = '{"model":"external-edit"}\n';
  const persistCredential = provider.saveModelCredential;
  vi.spyOn(provider, "saveModelCredential").mockImplementationOnce(
    async (...args) => {
      const result = await persistCredential(...args);
      await writeFile(childPath, external);
      return result;
    },
  );

  await expect(fixture.service.add(cloudInput)).rejects.toMatchObject({
    code: "config_changed",
    statusCode: 409,
    credentialSaved: true,
  });
  expect(await readFile(fixture.configPath, "utf8")).toBe(rootBytes);
  expect(await readFile(childPath, "utf8")).toBe(external);
  expect(await fixture.readEnv()).toContain("fixture-private-key");
});

test("a retargeted orphan link cannot be registered during adoption", async () => {
  await fixture.service.add(input);
  const config = await fixture.readConfig();
  delete config.models.profiles.extra;
  await fixture.writeConfig(config);
  const rootBytes = await readFile(fixture.configPath, "utf8");
  const originalPath = join(dirname(fixture.configPath), "saved-orphan.json");
  const replacementPath = join(
    dirname(fixture.configPath),
    "replacement-orphan.json",
  );
  const original = await readFile(modelPath(), "utf8");
  await rename(modelPath(), originalPath);
  await writeFile(replacementPath, original);
  await symlink(originalPath, modelPath());
  const saveCredential = provider.saveModelCredential;
  vi.spyOn(provider, "saveModelCredential").mockImplementationOnce(
    async (...args) => {
      await rm(modelPath());
      await symlink(replacementPath, modelPath());
      return saveCredential(...args);
    },
  );

  await expect(fixture.service.add(input)).rejects.toMatchObject({
    code: "config_changed",
  });
  expect(await readFile(fixture.configPath, "utf8")).toBe(rootBytes);
  expect(await readFile(originalPath, "utf8")).toBe(original);
  expect(await readFile(replacementPath, "utf8")).toBe(original);
  expect(await realpath(modelPath())).toBe(replacementPath);
});

test("retry rejects a retargeted model-file link without overwriting either target", async () => {
  await fixture.service.add(input);
  const root = await readFile(fixture.configPath, "utf8");
  const originalPath = join(dirname(fixture.configPath), "saved-extra.json");
  const replacementPath = join(
    dirname(fixture.configPath),
    "replacement-extra.json",
  );
  const original = await readFile(modelPath(), "utf8");
  const replacement = JSON.stringify({
    ...JSON.parse(original),
    model: "external-replacement",
  });
  await rename(modelPath(), originalPath);
  await writeFile(replacementPath, replacement);
  await symlink(originalPath, modelPath());
  const prepare = provider.prepareModelCredential;
  vi.spyOn(provider, "prepareModelCredential").mockImplementationOnce(
    async (...args) => {
      const result = await prepare(...args);
      await rm(modelPath());
      await symlink(replacementPath, modelPath());
      return result;
    },
  );

  await expect(fixture.service.add(input)).rejects.toMatchObject({
    code: "config_changed",
    statusCode: 409,
  });
  expect(await readFile(fixture.configPath, "utf8")).toBe(root);
  expect(await readFile(originalPath, "utf8")).toBe(original);
  expect(await readFile(replacementPath, "utf8")).toBe(replacement);
  expect(await realpath(modelPath())).toBe(replacementPath);
});

test("a failed root save removes only the unchanged file created by this addition", async () => {
  const root = await readFile(fixture.configPath, "utf8");
  vi.spyOn(dashboard, "saveConfigDashboardFile").mockRejectedValueOnce(
    new Error("fixture-write-failure"),
  );
  await expect(fixture.service.add(input)).rejects.toMatchObject({
    code: "model_save_failed",
  });
  expect(await readFile(fixture.configPath, "utf8")).toBe(root);
  await expect(readFile(modelPath(), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fixture.service.add(input)).resolves.toMatchObject({
    model: { profileId: "extra" },
  });
});

test.each(["edited", "removed"])(
  "a profile %s after the root commit does not turn a saved addition into a rejection",
  async (change) => {
    const save = dashboard.saveConfigDashboardFile;
    const external = '{"model":"external-owner-edit"}\n';
    vi.spyOn(dashboard, "saveConfigDashboardFile").mockImplementationOnce(
      async (...args) => {
        const result = await save(...args);
        if (change === "edited") await writeFile(modelPath(), external);
        else await rm(modelPath());
        return result;
      },
    );

    await expect(fixture.service.add(input)).resolves.toMatchObject({
      model: { profileId: "extra", model: "fixture-extra" },
      restartRequired: true,
    });
    expect((await fixture.readConfig()).models.profiles.extra).toEqual({
      configRef: "./models/extra.config.json",
    });
    if (change === "edited")
      expect(await readFile(modelPath(), "utf8")).toBe(external);
    else
      await expect(readFile(modelPath())).rejects.toMatchObject({
        code: "ENOENT",
      });
  },
);

test("a dangling model-file symlink is preserved and rejected before saving", async () => {
  const root = await readFile(fixture.configPath, "utf8");
  const missingTarget = "./missing-user-profile.json";
  await symlink(missingTarget, modelPath());
  const save = vi.spyOn(dashboard, "saveConfigDashboardFile");

  await expect(fixture.service.add(input)).rejects.toMatchObject({
    code: "model_profile_exists",
    statusCode: 409,
  });
  expect(save).not.toHaveBeenCalled();
  expect(await readFile(fixture.configPath, "utf8")).toBe(root);
  expect(await readlink(modelPath())).toBe(missingTarget);
  await expect(readFile(modelPath())).rejects.toMatchObject({ code: "ENOENT" });
});

test("an externally edited model file survives a failed root save", async () => {
  const root = await readFile(fixture.configPath, "utf8");
  const external = '{"model":"external-owner-edit"}\n';
  vi.spyOn(dashboard, "saveConfigDashboardFile").mockImplementationOnce(
    async () => {
      await writeFile(modelPath(), external);
      throw new Error("fixture-write-failure");
    },
  );
  await expect(fixture.service.add(input)).rejects.toMatchObject({
    code: "model_save_failed",
  });
  expect(await readFile(fixture.configPath, "utf8")).toBe(root);
  expect(await readFile(modelPath(), "utf8")).toBe(external);
});

test("a root changed by an external editor preserves the newly written file for inspection", async () => {
  vi.spyOn(dashboard, "saveConfigDashboardFile").mockImplementationOnce(
    async () => {
      const config = await fixture.readConfig();
      config.logging = { enabled: false };
      await fixture.writeConfig(config);
      throw new Error("fixture-external-root-edit");
    },
  );
  await expect(fixture.service.add(input)).rejects.toMatchObject({
    code: "model_save_failed",
  });
  expect((await fixture.readConfig()).logging).toEqual({ enabled: false });
  expect((await fixture.readConfig()).models.profiles.extra).toBeUndefined();
  expect(JSON.parse(await readFile(modelPath(), "utf8"))).toMatchObject({
    model: "fixture-extra",
  });
});

test("an existing file is preserved even when its name is not found by model discovery", async () => {
  // Discovery follows the first linked model's directory; creation still checks its own target.
  const config = await fixture.readConfig();
  const defaultProfile = await fixture.readModelProfile("default");
  config.models.profiles.default = { configRef: "./default.config.json" };
  await writeFile(
    join(dirname(fixture.configPath), "default.config.json"),
    JSON.stringify(defaultProfile),
  );
  await fixture.writeConfig(config);
  const existing = '{"model":"preserved-user-file"}\n';
  await writeFile(modelPath(), existing);
  await expect(fixture.service.add(input)).rejects.toMatchObject({
    code: "model_profile_exists",
  });
  expect(await fixture.readConfig()).toEqual(config);
  expect(await readFile(modelPath(), "utf8")).toBe(existing);
});

test("model-directory links outside the workspace are rejected before saving", async () => {
  const outside = await mkdtemp(
    join(dirname(fixture.rootDir), "models-outside-"),
  );
  try {
    const config = await fixture.readConfig();
    config.models.profiles.default = await fixture.readModelProfile("default");
    await fixture.writeConfig(config);
    const models = join(dirname(fixture.configPath), "models");
    await rm(models, { recursive: true });
    await symlink(outside, models);
    await expect(fixture.service.add(input)).rejects.toMatchObject({
      code: "model_config_outside_workspace",
    });
    expect(await fixture.readConfig()).toEqual(config);
    await expect(
      readFile(join(outside, "extra.config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
