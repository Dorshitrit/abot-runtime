import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getConfigDashboardSnapshot } from "./config-dashboard-backend.js";
import { buildConfigModelParameterPresentations } from "./model-parameter-presentation.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "abot-parameter-ui-"));
  const path = join(root, "runtime.config.json");
  await mkdir(join(root, "models"));
  await mkdir(join(root, "model-parameter-profiles"));
  await writeFile(join(root, "model-parameter-profiles", "fixture.json"), JSON.stringify({
    schemaVersion: 1, id: "fixture", match: [{ kind: "exact", provider: "llamacpp", pattern: "test-model" }],
    defaults: { temperature: 1, top_k: 0 },
    reasoning: { efforts: ["low", "medium", "high"], mappings: { xhigh: "high", none: null }, canDisableThinking: false }, notes: "Budget is shared.",
  }));
  await writeFile(join(root, "models", "test.json"), JSON.stringify({
    provider: "local", model: "test-model", supportsThinking: true, contextWindowTokens: 4096,
    generation: { temperature: 0.2, reasoningEffort: "xhigh" },
    calibration: { task: { profileId: "remote", generation: { topP: 0.5 } } },
  }));
  await writeFile(path, JSON.stringify({ models: {
    providers: { local: { type: "llamacpp" }, cloud: { type: "openai" } },
    profiles: { test: { configRef: "./models/test.json", generation: { topP: 0.9 } },
      remote: { provider: "cloud", model: "other", contextWindowTokens: 4096 } },
  } }));
  return { path, snapshot: await getConfigDashboardSnapshot({ rootDir: root, configPath: path }) };
}

describe("model parameter dashboard projection", () => {
  test("shows recommendations separately, retains saved values and model-specific effort mapping without writes", async () => {
    const { path, snapshot } = await fixture();
    const before = await readFile(join(root, "models", "test.json"), "utf8");
    const metadata = snapshot.modelParameters!.test.model;
    expect(metadata.parameters.find((field) => field.key === "temperature")).toMatchObject({ configuredValue: 0.2, value: 0.2, recommended: 1, source: "configuration" });
    expect(metadata.parameters.find((field) => field.key === "top_p")).toMatchObject({ value: 0.9, source: "configuration", explicit: false });
    expect(metadata.parameters.find((field) => field.key === "reasoning_effort")).toMatchObject({ configuredValue: "xhigh", value: "high", values: ["low", "medium", "high"] });
    expect(metadata.notes).toBe("Budget is shared.");
    expect(snapshot.files.models.find((file) => file.id === "test")!.config).not.toHaveProperty("modelParameters");
    expect(snapshot.modelParameters!.test.calibration.task.parameters.find((field) => field.key === "top_k")?.supported).toBe(false);
    expect(buildConfigModelParameterPresentations(snapshot, path).test.model.profileId).toBe("fixture");
    expect(await readFile(join(root, "models", "test.json"), "utf8")).toBe(before);
  });

  test("recomputes unsaved target identities and explicit omission without applying profile defaults on load", async () => {
    const { path, snapshot } = await fixture();
    const candidate = { modelId: "test", providers: { local: { type: "llamacpp" }, cloud: { type: "openai" } }, models: [{
      id: "test", provider: "local", model: "no-profile", supportsThinking: true,
      generation: { parameters: { temperature: { mode: "omit" } } },
      calibration: { task: { profileId: "remote", generation: {} } },
    }] };
    const metadata = buildConfigModelParameterPresentations(snapshot, path, candidate).test;
    expect(metadata.model.profileId).toBeUndefined();
    expect(metadata.model.parameters.find((field) => field.key === "temperature")).toMatchObject({ omitted: true, control: { mode: "omit" } });
    expect(metadata.model.parameters.find((field) => field.key === "top_k")).toMatchObject({ supported: true, omitted: true });
    expect(snapshot.files.models.find((file) => file.id === "test")!.config.generation).toEqual({ temperature: 0.2, reasoningEffort: "xhigh" });
  });

  test("projects saved native options and only advertises native parameter keys for draft previews", async () => {
    const { path, snapshot } = await fixture();
    const candidate = { modelId: "test", providers: { local: { type: "ollama" } }, models: [{
      id: "test", provider: "local", model: "native-fixture", generation: {},
      options: { top_k: 19, private_option: "private-value" }, calibration: {},
    }] };
    const metadata = buildConfigModelParameterPresentations(snapshot, path, candidate).test.model;
    expect(metadata.parameters.find((field) => field.key === "top_k")).toMatchObject({ value: 19, source: "configuration" });
    expect(metadata.nativeOptionKeys).toContain("top_k");
    expect(JSON.stringify(metadata)).not.toContain("private-value");
    expect(JSON.stringify(metadata)).not.toContain("private_option");
  });
});
