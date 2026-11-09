import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createSparkHomeSettingsService } from "../spark-home/settings/service.js";
import type { SparkHomeSettingsUpdate } from "../spark-home/settings/contracts.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  await disposeCompositionFixtures();
});
async function fixture() {
  const base = join(process.cwd(), ".codex/artifacts/spark-home-isolated-20261102/settings");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-")); roots.push(directory);
  let sparkModel: string | null = "spark";
  const config = await createRuntimeConfig();
  config.models = { defaults: { profileId: "spark" }, providers: { local: { type: "ollama" } }, profiles: {
    spark: { provider: "local", model: "spark" }, home: { provider: "local", model: "home", label: "My EA" },
  } };
  config.modelExecutionPolicies = { home: { policy: "execution-agent-v1" } };
  const options = { runtimeDirectory: directory, config, getSparkModelProfileId: async () => sparkModel };
  const service = createSparkHomeSettingsService(options);
  const input: SparkHomeSettingsUpdate = { expectedRevision: 0, personalInstructions: "Useful local history", modelProfileId: "home" };
  return { directory, config, options, service, input, setSparkModel: (value: string | null) => { sparkModel = value; } };
}

test("initial HOME requires explicit EA selection and saved personal requirements", async () => {
  const f = await fixture();
  expect(await f.service.read()).toEqual({ revision: 0, personalInstructions: "", modelProfileId: null,
    effectiveModelProfileId: null, calibrationRequired: true, available: false, reason: "spark_home_model_required",
    models: [{ id: "home", label: "My EA", providerId: "local", provider: "ollama" }], schedulingAvailable: false });
  await expect(f.service.prepareRequest()).rejects.toThrow("spark_home_model_required");
  await f.service.update({ ...f.input, personalInstructions: " " });
  await expect(f.service.prepareRequest()).rejects.toThrow("spark_home_calibration_required");
  await f.service.update({ ...f.input, expectedRevision: 1 });
  expect(await f.service.prepareRequest()).toEqual({ revision: 2, personalInstructions: f.input.personalInstructions,
    modelProfileId: "home", executionPolicy: "execution-agent-v1" });
});

test("legacy settings stay readable and inert schedule fields survive manual updates", async () => {
  const f = await fixture();
  await mkdir(join(f.directory, "spark-home"), { recursive: true });
  const file = join(f.directory, "spark-home/settings.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, revision: 3, jobId: "legacy-job", fullAccessGranted: true,
    personalInstructions: "Saved interests", modelProfileId: "spark" }));
  expect(await f.service.read()).toMatchObject({ revision: 3, modelProfileId: "spark", available: false,
    reason: "spark_home_execution_agent_required", schedulingAvailable: false });
  await expect(f.service.prepareRequest()).rejects.toThrow("spark_home_execution_agent_required");
  await f.service.update({ ...f.input, expectedRevision: 3 });
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ revision: 4, jobId: "legacy-job", fullAccessGranted: true });
  expect(await createSparkHomeSettingsService(f.options).read()).toMatchObject({ revision: 4, available: true });
  expect(await f.service.read()).not.toHaveProperty("jobId");
});

test("no inherited profile, SUPER selection or configured profile override can activate HOME", async () => {
  const f = await fixture();
  await expect(f.service.update({ ...f.input, modelProfileId: "spark" })).rejects.toThrow("spark_home_execution_agent_required");
  await f.service.update(f.input);
  f.setSparkModel(null);
  await expect(f.service.prepareRequest()).rejects.toThrow("spark_chat_model_required");
  f.setSparkModel("spark");
  f.config.models!.defaults!.overrideClientPreference = true;
  await expect(f.service.prepareRequest()).rejects.toThrow("spark_home_model_unavailable");
  f.config.models!.defaults!.overrideClientPreference = false;
  f.config.modelExecutionPolicies = {};
  await expect(f.service.prepareRequest()).rejects.toThrow("spark_home_execution_agent_required");
  expect((await f.service.read()).models).toEqual([]);
});

test("revision conflicts and legacy scheduling payloads cannot mutate preferences", async () => {
  const f = await fixture();
  await f.service.update(f.input);
  await expect(f.service.update(f.input)).rejects.toThrow("spark_home_settings_conflict");
  await expect(f.service.prepareRequest({ expectedRevision: 0 })).rejects.toThrow("spark_home_settings_conflict");
  await expect(f.service.update({ ...f.input, expectedRevision: 1, enabled: true } as SparkHomeSettingsUpdate))
    .rejects.toThrow("spark_home_settings_invalid");
  expect((await f.service.read()).revision).toBe(1);
});

test("final commit admission observes current saved settings and serializes competing changes", async () => {
  const f = await fixture();
  await f.service.update(f.input);
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const action = vi.fn(async current => { entered(); await pending; return current; });
  const commit = f.service.withCalibrationReady(action);
  await ready;
  let updated = false;
  const update = f.service.update({ ...f.input, expectedRevision: 1, personalInstructions: "Changed" }).then(() => { updated = true; });
  await Promise.resolve();
  expect(updated).toBe(false);
  release();
  expect(await commit).toMatchObject({ revision: 1, modelProfileId: "home", executionPolicy: "execution-agent-v1" });
  await update;
  expect((await f.service.prepareRequest()).personalInstructions).toBe("Changed");
});

test("cancelled admission and maximum escaped personal instructions preserve the contract", async () => {
  const f = await fixture();
  const instructions = "\u0001".repeat(4000);
  await f.service.update({ ...f.input, personalInstructions: instructions });
  expect((await createSparkHomeSettingsService(f.options).read()).personalInstructions).toBe(instructions);
  const controller = new AbortController(); controller.abort();
  await expect(f.service.prepareRequest({ abortSignal: controller.signal })).rejects.toThrow();
});
