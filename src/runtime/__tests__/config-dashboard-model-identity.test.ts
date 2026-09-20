import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { assignDiscoveredModelIds } from "../../web-ui/config-dashboard-model-identity.js";
import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
  type ConfigDashboardSnapshot,
} from "../../web-ui/config-dashboard-backend.js";
// @ts-expect-error Browser JavaScript has no declaration surface.
import { createConfigWorkspaceModel } from "../../web-ui/app/components/config-workspace/config-model.js";

let rootDir: string;
let configPath: string;
const options = () => ({ rootDir, configPath });
const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8"));
const writeJson = (path: string, config: unknown) =>
  writeFile(path, JSON.stringify(config));
beforeEach(async () => {
  const artifacts = resolve(
    ".codex/artifacts/pr71-third-review-20260908/model-identities",
  );
  await mkdir(artifacts, { recursive: true });
  rootDir = await mkdtemp(join(artifacts, "fixture-"));
  configPath = join(rootDir, "runtime.json");
  await mkdir(join(rootDir, "models"));
  await writeJson(configPath, {});
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});
async function modelFile(name: string) {
  await writeJson(join(rootDir, "models", name), {
    model: name,
    contextWindowTokens: 32768,
  });
}
function identityByPath(snapshot: ConfigDashboardSnapshot) {
  return snapshot.files.models.map(({ id, path }) => ({ id, path }));
}
async function verifyIndependentSaves(snapshot: ConfigDashboardSnapshot) {
  const models = snapshot.files.models;
  expect(new Set(models.map(({ id }) => id)).size).toBe(models.length);
  const workspace = createConfigWorkspaceModel();
  workspace.state.configDashboard = snapshot;
  workspace.captureBaselines();
  expect(workspace.state.baselinesByKey.size).toBe(models.length + 1);
  const expected = new Map(
    models.map((file) => [file.path, structuredClone(file.config)]),
  );
  for (const file of models) {
    expect(workspace.findConfigFile("model", file.id)).toBe(file);
    const key = workspace.configFileKey(file);
    workspace.state.selectedRawConfigKey = key;
    expect(workspace.selectedRawConfigFile()).toBe(file);
    file.config.contextWindowTokens = 65536;
    expect(workspace.dirtyFiles()).toEqual([file]);
    const saved = await saveConfigDashboardFile({
      ...options(),
      kind: "model",
      id: file.id,
      config: file.config,
      expectedRevision: file.revision,
    });
    expect(saved.file.id).toBe(file.id);
    expect(saved.file.path).toBe(file.path);
    expected.set(file.path, structuredClone(file.config));
    for (const [path, config] of expected)
      expect(await readJson(resolve(rootDir, path))).toEqual(config);
    workspace.captureBaselines();
  }
  expect(identityByPath(await getConfigDashboardSnapshot(options()))).toEqual(
    identityByPath(snapshot),
  );
}

test("same-basename discovered files retain independent selections, drafts and save targets", async () => {
  for (const name of ["foo.json", "foo.config.json", "ordinary.json"])
    await modelFile(name);
  const snapshot = await getConfigDashboardSnapshot(options());
  expect(snapshot.files.models).toHaveLength(3);
  expect(
    snapshot.files.models.find(({ path }) => path.endsWith("ordinary.json"))
      ?.id,
  ).toBe("ordinary");
  await verifyIndependentSaves(snapshot);
});

test("an orphan keeps its own identity when a configured profile has the same basename ID", async () => {
  await writeJson(configPath, {
    models: { profiles: { foo: { configRef: "./models/configured.json" } } },
  });
  for (const name of ["foo.json", "configured.json"]) await modelFile(name);
  const snapshot = await getConfigDashboardSnapshot(options());
  expect(snapshot.files.models).toHaveLength(2);
  expect(snapshot.files.models[0]).toMatchObject({
    id: "foo",
    path: "models/configured.json",
  });
  await verifyIndependentSaves(snapshot);
});

test("a discovered collision cannot replace an inline configured profile ID", async () => {
  const inline = { model: "inline", contextWindowTokens: 32768 };
  await writeJson(configPath, { models: { profiles: { foo: inline } } });
  await modelFile("foo.json");
  const snapshot = await getConfigDashboardSnapshot(options());
  const configured = snapshot.files.models.find(
    ({ source }) => source?.profileId === "foo",
  )!;
  const discovered = snapshot.files.models.find(({ source }) => !source)!;
  expect(configured.id).toBe("foo");
  expect(discovered.id).not.toBe("foo");
  const saved = await saveConfigDashboardFile({
    ...options(),
    kind: "model",
    id: discovered.id,
    config: { ...discovered.config, contextWindowTokens: 65536 },
    expectedRevision: discovered.revision,
  });
  expect(saved.file.path).toBe("models/foo.json");
  expect((await readJson(configPath)).models.profiles.foo).toEqual(inline);
});

test("path identities are case-sensitive, encoded and independent of discovery order", () => {
  const refs = [
    { id: "duplicate", path: "models/a b.json" },
    { id: "duplicate", path: "models/a%20b.json" },
    { id: "duplicate", path: "models/A b.json" },
    { id: "Ordinary", path: "models/Ordinary.json" },
    { id: "ordinary", path: "models/ordinary.json" },
  ];
  const ids = assignDiscoveredModelIds([], refs);
  expect(assignDiscoveredModelIds([], [...refs].reverse())).toEqual(ids);
  expect(ids).toEqual([
    { id: "Ordinary", path: "models/Ordinary.json" },
    { id: "file:models/A%20b.json", path: "models/A b.json" },
    { id: "file:models/a%20b.json", path: "models/a b.json" },
    { id: "file:models/a%2520b.json", path: "models/a%20b.json" },
    { id: "ordinary", path: "models/ordinary.json" },
  ]);
});

test("path identities cannot consume configured or ordinary IDs in the same namespace", () => {
  const configured = [
    "foo",
    "file:models/foo.json",
    "file:file:models/foo.json",
  ];
  const refs = [
    { id: "foo", path: "models/foo.json" },
    { id: "file:models/foo.config.json", path: "models/literal.json" },
    { id: "foo", path: "models/foo.config.json" },
  ];
  const result = assignDiscoveredModelIds(configured, refs);
  expect(new Set([...configured, ...result.map(({ id }) => id)]).size).toBe(
    configured.length + refs.length,
  );
  expect(result.find(({ path }) => path === "models/foo.json")?.id).toBe(
    "file:file:file:models/foo.json",
  );
  expect(result.find(({ path }) => path === "models/foo.config.json")?.id).toBe(
    "file:file:models/foo.config.json",
  );
  expect(result.find(({ path }) => path === "models/literal.json")?.id).toBe(
    "file:models/foo.config.json",
  );
  expect(
    assignDiscoveredModelIds([...configured].reverse(), [...refs].reverse()),
  ).toEqual(result);
});

test("empty and trim-unstable basename IDs receive round-trippable path identities", async () => {
  for (const name of [".json", " leading.json", "trailing .json"])
    await modelFile(name);
  const snapshot = await getConfigDashboardSnapshot(options());
  expect(snapshot.files.models.every(({ id }) => id && id.trim() === id)).toBe(
    true,
  );
  await verifyIndependentSaves(snapshot);
});
