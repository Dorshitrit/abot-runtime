import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as transactions from "../adapters/config-file-transaction.js";
import * as dashboard from "../../web-ui/config-dashboard-backend.js";
import { ModelSetupService } from "../../web-ui/local-runtime/model-setup-service.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr86-canonical-snapshots-20260923/locked-source",
  );
});
afterEach(async () => fixture.cleanup());

const input = {
  profileId: "extra",
  model: "fixture-extra",
  providerId: "ollama",
};

async function createSelectedConfigLink(config: Record<string, unknown>) {
  const directory = dirname(fixture.configPath);
  const alias = join(directory, "selected-runtime.json");
  const replacement = join(directory, "replacement-runtime.json");
  await writeFile(replacement, JSON.stringify(config));
  await symlink(fixture.configPath, alias);
  return {
    alias,
    replacement,
    service: new ModelSetupService({
      rootDir: fixture.rootDir,
      getConfigPath: () => alias,
    }),
  };
}

function retargetSourceAfterCanonicalGuard(
  selected: Awaited<ReturnType<typeof createSelectedConfigLink>>,
) {
  const canonicalPath = transactions.canonicalConfigFilePath;
  const dashboardSnapshot = dashboard.getConfigDashboardSnapshot;
  let retargeted = false;
  vi.spyOn(transactions, "canonicalConfigFilePath").mockImplementation(
    async (path) => {
      const result = await canonicalPath(path);
      if (path !== selected.alias || retargeted) return result;
      retargeted = true;
      await rm(selected.alias);
      await symlink(selected.replacement, selected.alias);
      return result;
    },
  );
  vi.spyOn(dashboard, "getConfigDashboardSnapshot").mockImplementationOnce(
    async (...args) => {
      expect(retargeted).toBe(true);
      await rm(selected.alias);
      await symlink(fixture.configPath, selected.alias);
      return dashboardSnapshot(...args);
    },
  );
}

test("addition preserves locked root settings through a selected-link ABA", async () => {
  const original = await fixture.readConfig();
  const replacement = structuredClone(original);
  replacement.logging = { ...replacement.logging, enabled: false };
  replacement.models.profiles.default = {
    ...(await fixture.readModelProfile("default")),
    model: "replacement-default",
  };
  const selected = await createSelectedConfigLink(replacement);
  const replacementBytes = await readFile(selected.replacement, "utf8");
  retargetSourceAfterCanonicalGuard(selected);

  await expect(selected.service.add(input)).resolves.toMatchObject({
    model: { profileId: "extra" },
  });

  const saved = await fixture.readConfig();
  expect(saved.models.profiles.extra).toEqual({
    configRef: "./models/extra.config.json",
  });
  delete saved.models.profiles.extra;
  expect(saved).toEqual(original);
  expect(await readFile(selected.replacement, "utf8")).toBe(replacementBytes);
});

test("retry cannot acknowledge a matching model from a temporary replacement root", async () => {
  await fixture.service.add(input);
  const expectedProfile = await fixture.readModelProfile("extra");
  const original = await fixture.readConfig();
  original.models.profiles.extra = {
    ...expectedProfile,
    model: "original-unrelated-model",
  };
  await fixture.writeConfig(original);
  const originalBytes = await readFile(fixture.configPath, "utf8");
  const replacement = structuredClone(original);
  replacement.models.profiles.extra = expectedProfile;
  const selected = await createSelectedConfigLink(replacement);
  const replacementBytes = await readFile(selected.replacement, "utf8");
  retargetSourceAfterCanonicalGuard(selected);

  await expect(selected.service.add(input)).rejects.toMatchObject({
    code: "model_profile_exists",
    statusCode: 409,
  });

  expect(await readFile(fixture.configPath, "utf8")).toBe(originalBytes);
  expect(await readFile(selected.replacement, "utf8")).toBe(replacementBytes);
});

test("failed save cannot be confirmed from a retargeted selected config", async () => {
  const original = await fixture.readConfig();
  const originalBytes = await readFile(fixture.configPath, "utf8");
  const selected = await createSelectedConfigLink(original);
  vi.spyOn(dashboard, "saveConfigDashboardFile").mockImplementationOnce(
    async ({ config }) => {
      await writeFile(selected.replacement, JSON.stringify(config));
      await rm(selected.alias);
      await symlink(selected.replacement, selected.alias);
      throw new Error("fixture-root-save-failed");
    },
  );

  await expect(selected.service.add(input)).rejects.toMatchObject({
    code: "model_save_failed",
    statusCode: 500,
  });

  expect(await readFile(fixture.configPath, "utf8")).toBe(originalBytes);
  await expect(
    readFile(join(dirname(fixture.configPath), "models/extra.config.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("a root removed before locking cannot become an empty addition base", async () => {
  const withTransaction = transactions.withConfigFileTransaction;
  const removeBeforeLock: typeof withTransaction = async (
    path,
    operation,
    options,
  ) => {
    await rm(path);
    return withTransaction(path, operation, options);
  };
  vi.spyOn(transactions, "withConfigFileTransaction").mockImplementationOnce(
    removeBeforeLock,
  );

  await expect(fixture.service.add(input)).rejects.toMatchObject({
    code: "config_changed",
    statusCode: 409,
  });
  await expect(readFile(fixture.configPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
