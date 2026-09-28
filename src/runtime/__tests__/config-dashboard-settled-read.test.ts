import {
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as transactions from "../adapters/config-file-transaction.js";
import * as dashboardTransactions from "../../web-ui/config-dashboard-save-transaction.js";
import { getSettledConfigDashboardSnapshot } from "../../web-ui/config-dashboard-backend.js";

let rootDir: string;
let configPath: string;
let canonicalPath: string;
let replacementPath: string;
let runnerPath: string;
const primaryInline = { model: "primary-inline", contextWindowTokens: 32768 };
const lexicalModel = { model: "lexical-model", contextWindowTokens: 65536 };
const lexicalRunner = { marker: "lexical-runner" };
const primaryConfig = {
  marker: "primary-root",
  models: {
    profiles: {
      inline: primaryInline,
      linked: { configRef: "./models/linked.json" },
    },
  },
  requestRunner: { configRef: "./runner.json" },
};
const replacementConfig = {
  ...primaryConfig,
  marker: "replacement-root",
  models: {
    profiles: {
      inline: { ...primaryInline, model: "replacement-inline" },
      linked: { configRef: "./models/linked.json" },
    },
  },
};
const writeJson = (path: string, config: unknown) =>
  writeFile(path, JSON.stringify(config));

beforeEach(async () => {
  const artifacts = resolve(
    ".codex/artifacts/pr86-canonical-snapshots-20260923/settled-read",
  );
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "fixture-"));
  const lexicalDir = join(rootDir, "selected");
  const canonicalDir = join(rootDir, "canonical");
  await mkdir(join(lexicalDir, "models"), { recursive: true });
  await mkdir(join(canonicalDir, "models"), { recursive: true });
  configPath = join(lexicalDir, "runtime.json");
  canonicalPath = join(canonicalDir, "primary.json");
  replacementPath = join(canonicalDir, "replacement.json");
  runnerPath = join(lexicalDir, "runner.json");
  await writeJson(canonicalPath, primaryConfig);
  await writeJson(replacementPath, replacementConfig);
  await writeJson(runnerPath, lexicalRunner);
  await writeJson(join(lexicalDir, "models/linked.json"), lexicalModel);
  await writeJson(join(canonicalDir, "runner.json"), {
    marker: "wrong-canonical-runner",
  });
  await writeJson(join(canonicalDir, "models/linked.json"), {
    model: "wrong-canonical-model",
  });
  await symlink(canonicalPath, configPath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(rootDir, { recursive: true, force: true });
});

async function selectRuntimeTarget(target: string) {
  await rm(configPath);
  await symlink(target, configPath);
}

function retargetAfterLockedIdentityCheck(restoreDuringProjection: boolean) {
  const resolveCanonical = transactions.canonicalConfigFilePath;
  const withRoot = dashboardTransactions.withConfigDashboardRootTransaction;
  let retargeted = false;
  let restored = false;
  vi.spyOn(
    dashboardTransactions,
    "withConfigDashboardRootTransaction",
  ).mockImplementation((path, transaction, operation) =>
    withRoot(path, transaction, async (root) => {
      // Arm only after acquisition, so the hook targets the selected-path check.
      vi.spyOn(transactions, "canonicalConfigFilePath").mockImplementation(
        async (selectedPath) => {
          const canonical = await resolveCanonical(selectedPath);
          const isInitialSelectedRead =
            selectedPath === configPath && !retargeted;
          if (isInitialSelectedRead) {
            expect(canonical).toBe(root.path);
            await selectRuntimeTarget(replacementPath);
            retargeted = true;
            return canonical;
          }
          const isProjectionRestore =
            restoreDuringProjection && selectedPath === runnerPath && !restored;
          if (isProjectionRestore) {
            await selectRuntimeTarget(canonicalPath);
            restored = true;
          }
          return canonical;
        },
      );
      return operation(root);
    }),
  );
  return {
    wasRetargeted: () => retargeted,
    wasRestored: () => restored,
  };
}

test("settled reads reject a selected symlink retargeted after the initial locked identity check", async () => {
  const race = retargetAfterLockedIdentityCheck(false);
  await expect(
    getSettledConfigDashboardSnapshot({ rootDir, configPath }),
  ).rejects.toBeInstanceOf(transactions.ConfigFileConflictError);
  expect(race.wasRetargeted()).toBe(true);
  expect(await readlink(configPath)).toBe(replacementPath);
});

test("settled reads retain the locked root snapshot through ABA retargeting and preserve lexical references", async () => {
  const expectedRoot = await transactions.readConfigFileSnapshot(canonicalPath);
  const replacement =
    await transactions.readConfigFileSnapshot(replacementPath);
  const race = retargetAfterLockedIdentityCheck(true);
  const dashboard = await getSettledConfigDashboardSnapshot({
    rootDir,
    configPath,
  });
  expect(race.wasRetargeted()).toBe(true);
  expect(race.wasRestored()).toBe(true);
  expect(await readlink(configPath)).toBe(canonicalPath);
  expect(dashboard.files.runtime).toMatchObject({
    path: relative(rootDir, configPath),
    config: primaryConfig,
    revision: expectedRoot.revision,
  });
  expect(dashboard.files.runtime.revision).not.toBe(replacement.revision);
  expect(
    dashboard.files.models.find(({ id }) => id === "inline"),
  ).toMatchObject({
    config: primaryInline,
    revision: expectedRoot.revision,
    source: { runtimeConfigPath: configPath, profileId: "inline" },
  });
  expect(
    dashboard.files.models.find(({ id }) => id === "linked"),
  ).toMatchObject({
    path: "selected/models/linked.json",
    config: lexicalModel,
  });
  expect(dashboard.files.requestRunner).toMatchObject({
    path: "selected/runner.json",
    config: lexicalRunner,
  });
});
