import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../../web-ui/config-dashboard-backend.js";
import {
  readConfigFileSnapshot,
  withConfigFileTransaction,
} from "../adapters/config-file-transaction.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";

let fixture: ModelSetupFixture;
afterEach(async () => {
  await fixture?.cleanup();
});
async function prepare(kind: "model" | "requestRunner") {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-save-repair-20260908/malformed",
  );
  const config = await fixture.readConfig();
  const modelId = Object.keys(config.models.profiles)[0]!;
  const ref =
    kind === "model"
      ? config.models.profiles[modelId].configRef
      : config.requestRunner.configRef;
  const path = resolve(dirname(fixture.configPath), ref);
  const candidate = JSON.parse(await readFile(path, "utf8"));
  const raw = Buffer.from([123, 34, 120, 34, 58, 0xff, 125]);
  await writeFile(path, raw);
  return {
    path,
    candidate,
    raw,
    kind,
    id: kind === "model" ? modelId : "requestRunner",
  };
}
function target(
  snapshot: Awaited<ReturnType<typeof getConfigDashboardSnapshot>>,
  kind: string,
) {
  return kind === "model"
    ? snapshot.files.models[0]!
    : snapshot.files.requestRunner!;
}

test.each(["model", "requestRunner"] as const)(
  "Configuration repairs malformed %s with an exact original-byte backup",
  async (kind) => {
    const file = await prepare(kind);
    await expect(readConfigFileSnapshot(file.path)).rejects.toThrow();
    await expect(
      withConfigFileTransaction(file.path, async () => {}),
    ).rejects.toThrow();
    const snapshot = await getConfigDashboardSnapshot(fixture);
    const broken = target(snapshot, kind);
    expect(broken).toMatchObject({
      exists: true,
      config: {},
      invalidJson: { raw: file.raw.toString("utf8") },
    });
    const saved = await saveConfigDashboardFile({
      ...fixture,
      kind,
      id: file.id,
      config: file.candidate,
      expectedRevision: broken.revision,
    });
    expect(saved.file).not.toHaveProperty("invalidJson");
    expect(JSON.parse(await readFile(file.path, "utf8"))).toEqual(
      file.candidate,
    );
    expect(await readFile(resolve(fixture.rootDir, saved.backupPath!))).toEqual(
      file.raw,
    );
    const registry = new RuntimeEnvironmentRegistry({
      rootDir: fixture.rootDir,
      configPath: fixture.configPath,
      defaultEnvironmentId: "prod",
    });
    expect(registry.modelCatalog("prod").availability.status).toBe("ready");
  },
);

test("an untouched malformed sibling does not prevent repairing the selected file", async () => {
  const file = await prepare("requestRunner");
  const config = await fixture.readConfig();
  const model = Object.values(config.models.profiles)[0] as {
    configRef: string;
  };
  const modelPath = resolve(dirname(fixture.configPath), model.configRef);
  await writeFile(modelPath, "{broken-model");
  const snapshot = await getConfigDashboardSnapshot(fixture);
  await saveConfigDashboardFile({
    ...fixture,
    kind: "requestRunner",
    config: file.candidate,
    expectedRevision: snapshot.files.requestRunner!.revision,
  });
  expect(await readFile(modelPath, "utf8")).toBe("{broken-model");
});

test("malformed replacement requires a revision and rejects concurrent changes", async () => {
  const file = await prepare("model");
  const snapshot = await getConfigDashboardSnapshot(fixture);
  await expect(
    saveConfigDashboardFile({
      ...fixture,
      kind: "model",
      id: file.id,
      config: file.candidate,
    }),
  ).rejects.toMatchObject({ code: "config_changed" });
  await writeFile(file.path, "{new-external-edit");
  await expect(
    saveConfigDashboardFile({
      ...fixture,
      kind: "model",
      id: file.id,
      config: file.candidate,
      expectedRevision: snapshot.files.models[0]!.revision,
    }),
  ).rejects.toMatchObject({ code: "config_changed" });
  expect(await readFile(file.path, "utf8")).toBe("{new-external-edit");
});

test("a repaired runner candidate must pass strict version and shape validation", async () => {
  const file = await prepare("requestRunner");
  const snapshot = await getConfigDashboardSnapshot(fixture);
  await expect(
    saveConfigDashboardFile({
      ...fixture,
      kind: "requestRunner",
      config: { ...file.candidate, schemaVersion: 999 },
      expectedRevision: snapshot.files.requestRunner!.revision,
    }),
  ).rejects.toThrow();
  expect(await readFile(file.path)).toEqual(file.raw);
});

test("the root runtime file is never silently replaced by malformed-file recovery", async () => {
  await prepare("model");
  await writeFile(fixture.configPath, "{broken-root");
  await expect(getConfigDashboardSnapshot(fixture)).rejects.toThrow();
  expect(await readFile(fixture.configPath, "utf8")).toBe("{broken-root");
});

test("valid UTF-8 snapshots retain the existing canonical revision protocol", async () => {
  await prepare("model");
  const raw = await readFile(fixture.configPath, "utf8");
  const snapshot = await readConfigFileSnapshot(fixture.configPath);
  const expected = createHash("sha256")
    .update(fixture.configPath)
    .update(String.fromCharCode(0))
    .update("present:" + raw)
    .digest("hex");
  expect(snapshot.revision).toBe(expected);
});
