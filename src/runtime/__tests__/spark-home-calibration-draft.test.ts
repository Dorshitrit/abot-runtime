import { writeFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelGatewayClient, RuntimeConfig, ToolPermissionMode } from "../ports.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createSparkHomeCalibrationService } from "../spark-home/calibration/service.js";
import { parseSparkHomeCalibrationDraftInput } from "../spark-home/calibration/contracts.js";
import { EMPTY_SPARK_HOME_SETTINGS } from "../spark-home/settings/store.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

afterEach(disposeCompositionFixtures);
const input = { expectedRevision: 0, modelProfileId: "home", widgetIds: ["calendar"], topics: "astronomy", constraints: "Hebrew, concise" };
async function fixture() {
  const base = await createRuntimeConfig();
  await writeFile(base.requestRunner.configPath, JSON.stringify({ schemaVersion: 2,
    models: { defaults: { profileId: "spark", steps: {} } },
    context: { outputReserveTokens: 200, safetyReserveTokens: 50, attachmentReserveTokens: 1 },
    stepDefaults: { timeoutMs: 5000 }, steps: {} }));
  const config: RuntimeConfig = { ...base, modelExecutionPolicies: { home: { policy: "execution-agent-v1" } }, models: { defaults: { profileId: "spark" },
    providers: { cloud: { type: "openai" } }, profiles: {
      spark: { provider: "cloud", model: "spark", contextWindowTokens: 16000 },
      home: { provider: "cloud", model: "home", contextWindowTokens: 16000 },
    } } };
  let settings = EMPTY_SPARK_HOME_SETTINGS;
  let mode: ToolPermissionMode = "ask";
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => ({ text: "Show a useful astronomy digest and today's calendar.", meta: {} }));
  const models = { invoke, invokeRaw: vi.fn() };
  const tools = createConfiguredToolRegistry(undefined, []);
  const execute = vi.spyOn(tools, "execute");
  const service = createSparkHomeCalibrationService({ config,
    readSettings: async () => settings, getSparkModelProfileId: async () => "spark",
    dependencies: { models, tools, getSparkToolPermissionMode: async () => mode } });
  return { service, invoke, execute, models, config,
    changeSettings: () => { settings = { ...settings, revision: settings.revision + 1 }; },
    changeMode: () => { mode = "full_access"; } };
}

test("draft uses exactly one HOME utility call, explicit answers and selected capabilities without tools", async () => {
  const f = await fixture();
  const draft = await f.service.draft(input);
  expect(draft).toEqual({ personalInstructions: "Show a useful astronomy digest and today's calendar.", settingsRevision: 0, effectiveModelProfileId: "home" });
  expect(f.invoke).toHaveBeenCalledTimes(1);
  const call = f.invoke.mock.calls[0]![0];
  expect(call.modelStep).toBe("spark_home.calibration");
  expect(call.modelPreference).toEqual({ profileId: "home", scope: "all" });
  const messages = call.messages as ChatMessage[];
  expect(messages.map(message => message.role)).toEqual(["system", "user"]);
  expect(JSON.parse(messages[1]!.content)).toEqual({ selectedWidgets: ["calendar"], topics: input.topics, constraints: input.constraints });
  const reference = JSON.parse(messages[0]!.content.split("\n\n").at(-1)!);
  expect(reference.options.map((option: { id: string }) => option.id)).toEqual(["calendar"]);
  expect(reference).toMatchObject({ addsUserIntent: false, grantsActionAuthority: false, truncated: false,
    capabilities: { publicWebSearchAvailable: false, runtimeSystemStatusAvailable: true } });
  expect(reference.options.every((option: { nativeWidgetId?: string }) => option.nativeWidgetId === undefined)).toBe(true);
  expect(call).not.toHaveProperty("tools");
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.models.invokeRaw).not.toHaveBeenCalled();
});

test("selecting system status passes the exact native widget binding to drafting without a probe or live observations", async () => {
  const f = await fixture();
  await f.service.draft({ ...input, widgetIds: ["system_status"] });
  const messages = f.invoke.mock.calls[0]![0].messages as ChatMessage[];
  expect(messages.map(message => message.role)).toEqual(["system", "user"]);
  expect(JSON.parse(messages[1].content).selectedWidgets).toEqual(["system_status"]);
  const reference = JSON.parse(messages[0].content.split("\n\n").at(-1)!);
  expect(reference).toMatchObject({ addsUserIntent: false, grantsActionAuthority: false, applicability: "this_draft_only" });
  expect(reference.options).toHaveLength(1);
  expect(reference.options[0]).toMatchObject({ id: "system_status", nativeWidgetId: "system-metrics", available: true });
  expect(Object.keys(reference.options[0]).sort()).toEqual(["available", "description", "id", "label", "nativeWidgetId", "reason"]);
  expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled();
});

test("unavailable widgets, stale revisions and malformed inputs fail before any model call", async () => {
  const f = await fixture();
  await expect(f.service.draft({ ...input, widgetIds: ["web_topics"] })).rejects.toThrow("spark_home_calibration_options_changed");
  await expect(f.service.draft({ ...input, expectedRevision: 1 })).rejects.toThrow("spark_home_settings_conflict");
  expect(() => parseSparkHomeCalibrationDraftInput({ ...input, html: "<p>no</p>" })).toThrow("spark_home_calibration_invalid");
  expect(() => parseSparkHomeCalibrationDraftInput({ ...input, widgetIds: ["calendar", "calendar"] })).toThrow("spark_home_calibration_invalid");
  expect(() => parseSparkHomeCalibrationDraftInput({ ...input, topics: "x".repeat(1001) })).toThrow("spark_home_calibration_invalid");
  await expect(f.service.draft({ ...input, widgetIds: [], topics: " ", constraints: "" })).rejects.toThrow("spark_home_calibration_empty");
  expect(f.invoke).not.toHaveBeenCalled();
});

test.each(["", "x".repeat(4001)])("invalid model output stays an unsaved failure", async text => {
  const f = await fixture();
  f.invoke.mockResolvedValueOnce({ text, meta: {} });
  await expect(f.service.draft(input)).rejects.toThrow("spark_home_calibration_output_invalid");
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("changed settings or permission authority invalidate a completed draft even when options look identical", async () => {
  const f = await fixture();
  f.invoke.mockImplementationOnce(async () => { f.changeMode(); return { text: "Draft", meta: {} }; });
  await expect(f.service.draft(input)).rejects.toThrow("spark_home_calibration_options_changed");
  f.invoke.mockImplementationOnce(async () => { f.changeSettings(); return { text: "Draft", meta: {} }; });
  await expect(f.service.draft(input)).rejects.toThrow("spark_home_settings_conflict");
});

test("options require explicit selected EA model and parallel drafts are refused", async () => {
  const f = await fixture();
  await expect(f.service.readOptions({ expectedRevision: 0, modelProfileId: null })).rejects.toThrow("spark_home_model_required");
  await expect(f.service.readOptions({ expectedRevision: 0, modelProfileId: "spark" })).rejects.toThrow("spark_home_execution_agent_required");
  let release!: (value: { text: string; meta: {} }) => void;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  f.invoke.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
  const pending = f.service.draft(input);
  await running;
  await expect(f.service.draft(input)).rejects.toThrow("spark_home_calibration_busy");
  release({ text: "Draft", meta: {} });
  await expect(pending).resolves.toHaveProperty("personalInstructions", "Draft");
  await expect(f.service.draft(input)).resolves.toHaveProperty("settingsRevision", 0);
});

test("provider-truncated output is rejected without a repair call", async () => {
  const f = await fixture();
  f.invoke.mockResolvedValueOnce({ text: "Partial draft", meta: { providerCompletionReason: "length" } });
  await expect(f.service.draft(input)).rejects.toThrow("output_incomplete");
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("changed selected execution policy invalidates a draft before it can become saved instructions", async () => {
  const f = await fixture();
  f.invoke.mockImplementationOnce(async () => {
    f.config.modelExecutionPolicies = { home: { policy: "supervisor-worker-v1" } };
    return { text: "Draft from now unavailable model", meta: {} };
  });
  await expect(f.service.draft(input)).rejects.toThrow("spark_home_execution_agent_required");
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("cancelled calibration never invokes a model or returns a draft", async () => {
  const f = await fixture();
  const before = new AbortController(); before.abort();
  await expect(f.service.draft(input, before.signal)).rejects.toThrow();
  expect(f.invoke).not.toHaveBeenCalled();
  const during = new AbortController();
  f.invoke.mockImplementationOnce(async () => { during.abort(); return { text: "Cancelled draft", meta: {} }; });
  await expect(f.service.draft(input, during.signal)).rejects.toThrow();
  expect(f.invoke).toHaveBeenCalledTimes(1);
});
