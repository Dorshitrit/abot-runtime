import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { getConfigDashboardSnapshot } from "./config-dashboard-backend.js";
import { buildConfigModelParameterPresentations } from "./model-parameter-presentation.js";
import { parseModelParameterPreviewCandidate } from "./local-runtime/model-parameter-routes.js";
// @ts-expect-error Browser module has no declaration surface.
import { modelParameterPreviewCandidate } from "./app/components/config-workspace/model-parameter-preview.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

async function fixture(inlineTarget?: string) {
  root = await mkdtemp(join(tmpdir(), "abot-preview-candidates-"));
  await mkdir(join(root, "models"));
  const configPath = join(root, "runtime.config.json");
  await writeFile(join(root, "models", "orphan.config.json"), "{}");
  await writeFile(join(root, "models", "selected.config.json"), JSON.stringify({
    provider: "local", model: "generic", contextWindowTokens: 4096,
    ...(inlineTarget ? { calibration: { step: { profileId: "orphan" } } } : {}),
  }));
  await writeFile(configPath, JSON.stringify({ models: {
    providers: { local: { type: "llamacpp" }, brokenUnused: {} },
    profiles: {
      selected: { configRef: "./models/selected.config.json", ...(inlineTarget ? { calibration: { step: { profileId: inlineTarget } } } : {}) },
      target: { provider: "local", model: "target", contextWindowTokens: 4096 },
    },
  } }));
  const snapshot = await getConfigDashboardSnapshot({ rootDir: root, configPath });
  const state = { configDashboard: snapshot, selectedConfigModelId: "selected" };
  return { snapshot, state, configPath };
}

function candidate(state: unknown) {
  return JSON.parse(JSON.stringify(modelParameterPreviewCandidate(state)));
}

test("an empty unrelated discovered model and unused incomplete provider do not reject a valid preview", async () => {
  const { snapshot, state, configPath } = await fixture();
  expect(snapshot.files.models.some((file) => file.id === "orphan")).toBe(true);
  const parsed = parseModelParameterPreviewCandidate(candidate(state));
  expect(parsed.models.map((model) => model.id)).toEqual(["selected"]);
  expect(parsed.providers).toEqual({ local: { type: "llamacpp" } });
  expect(buildConfigModelParameterPresentations(snapshot, configPath, parsed).selected.model.parameters.some((field) => field.key === "temperature" && field.supported)).toBe(true);
});

test("an incomplete calibration dependency remains in the candidate and is rejected instead of silently dropped", async () => {
  const { snapshot, state } = await fixture();
  snapshot.files.models.find((file) => file.id === "selected")!.config.calibration = { step: { profileId: "orphan" } };
  const input = candidate(state);
  expect(input.models.map((model: { id: string }) => model.id)).toContain("orphan");
  expect(() => parseModelParameterPreviewCandidate(input)).toThrow("Provider and model identities are required");
});

test("the selected incomplete model is never silently excluded", async () => {
  const { snapshot, state } = await fixture();
  snapshot.files.models.find((file) => file.id === "selected")!.config = {};
  expect(candidate(state).models).toEqual([{ id: "selected", generation: {}, calibration: {} }]);
  expect(() => parseModelParameterPreviewCandidate(candidate(state))).toThrow("Provider and model identities are required");
});

test("inline calibration targets determine dependencies over a linked file's superseded target", async () => {
  const { snapshot, state, configPath } = await fixture("target");
  const parsed = parseModelParameterPreviewCandidate(candidate(state));
  expect(parsed.models.map((model) => model.id).sort()).toEqual(["selected", "target"]);
  const scope = buildConfigModelParameterPresentations(snapshot, configPath, parsed).selected.calibration.step;
  expect(scope.parameters.some((field) => field.key === "temperature" && field.supported)).toBe(true);
});
