import { writeFile } from "node:fs/promises";
import { vi } from "vitest";
import type { ModelGatewayClient, RuntimeConfig, ToolPermissionMode } from "../../ports.js";
import type { ToolModuleDeclaration } from "../../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createSparkHomeGenerationService } from "../../spark-home/generation/service.js";
import type { SparkHomeGenerationDependencies, SparkHomeRunSnapshot, SparkHomePlan } from "../../spark-home/generation/contracts.js";
import type { SparkHomeRequestSettings } from "../../spark-home/settings/contracts.js";
import type { SparkHomeSnapshot } from "../../spark-home/contracts.js";
import type { SparkHomeAuthoringContext } from "../../spark-home/authoring-context/index.js";
import { createRuntimeConfig } from "./runtime-composition-fixture.js";

export function homeReadTool(name = "web_search"): ToolModuleDeclaration {
  return {
    definition: { name, pluginName: "web", routingCapability: "semantic_lookup", catalogGroups: ["web"] },
    normalInvocation: { version: 1, operations: [{ operationId: "search", summary: "Read current source evidence.", effect: "read_only",
      approval: "request_policy", input: { type: "object", additionalProperties: false,
        properties: { query: { type: "string", minLength: 1, maxLength: 100 } }, required: ["query"] } }] },
    implementation: vi.fn(async () => ({ ok: true, output: "SOURCE_OBSERVATION_42", producedNewInformation: true })),
  };
}

export async function createHomeGenerationFixture(modules: ToolModuleDeclaration[] = []) {
  const base = await createRuntimeConfig();
  await writeFile(base.requestRunner.configPath, JSON.stringify({ schemaVersion: 2,
    models: { defaults: { profileId: "home", steps: {} } },
    context: { outputReserveTokens: 200, safetyReserveTokens: 50, attachmentReserveTokens: 1 },
    stepDefaults: { timeoutMs: 5000 }, steps: {} }));
  const config: RuntimeConfig = { ...base, modelExecutionPolicies: { home: { policy: "execution-agent-v1" } }, models: {
    defaults: { profileId: "home" }, providers: { cloud: { type: "openai" } },
    profiles: { home: { provider: "cloud", model: "home", contextWindowTokens: 64000 },
      other: { provider: "cloud", model: "other", contextWindowTokens: 64000 } },
  } };
  let settings: SparkHomeRequestSettings = { revision: 1, personalInstructions: "Show sourced astronomy news and today's date.",
    modelProfileId: "home", executionPolicy: "execution-agent-v1" };
  let screen: SparkHomeSnapshot = { revision: 3, html: "<p>OLD_SCREEN</p>", updatedAt: "2026-11-02T00:00:00Z" };
  let saved: SparkHomeRunSnapshot | null = null;
  let mode: ToolPermissionMode = "full_access";
  let plan: SparkHomePlan = { direction: "A focused astronomy page", reads: [] };
  let followup: SparkHomePlan = { direction: "Write grounded astronomy page", reads: [] };
  let html = '<!doctype html><html><body>NEW_SCREEN<div data-abot-widget="spark-status"></div>'
    + '<div data-abot-widget="conversations"></div><div data-abot-widget="approvals"></div></body></html>';
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async input => ({ text: input.modelStep === "spark_home.html"
    ? html : JSON.stringify(input.modelStep === "spark_home.plan" ? plan : followup), meta: {} }));
  const models = { invoke, invokeRaw: vi.fn() };
  const update = vi.fn(async (input: { expectedRevision: number; html: string }) => {
    if (input.expectedRevision !== screen.revision) throw new Error("screen_stale");
    const next = { revision: screen.revision + 1, html: input.html, updatedAt: new Date().toISOString() };
    screen = next; return next;
  });
  const sources = { planning: { kind: "spark_home_planning_reference_v1", referenceMarker: "PLANNING_ONLY" },
    authoring: JSON.stringify({ oldHtml: screen.html, appearance: { background: "#123456", mandatory: false } }),
    resourceBindings: [] } as unknown as SparkHomeAuthoringContext;
  const context = { capture: vi.fn(async () => sources) };
  const dependencies: SparkHomeGenerationDependencies = {
    config, models, tools: createConfiguredToolRegistry(undefined, modules), context,
    settings: {
      prepareRequest: async input => {
        if (input?.expectedRevision !== settings.revision) throw new Error("spark_home_settings_conflict");
        return { ...settings };
      },
      withCalibrationReady: action => action(settings),
    },
    screen: { read: async () => screen, update }, getToolPermissionMode: async () => mode,
    store: { read: async () => saved, write: async snapshot => { saved = structuredClone(snapshot); } },
  };
  const service = createSparkHomeGenerationService(dependencies);
  return { service, dependencies, config, models, invoke, context, sources, update,
    screen: () => screen, saved: () => saved, setSaved: (value: SparkHomeRunSnapshot) => { saved = value; },
    changeSettings: () => { settings = { ...settings, revision: settings.revision + 1 }; },
    setMode: (value: ToolPermissionMode) => { mode = value; }, setHtml: (value: string) => { html = value; },
    setPlan: (value: SparkHomePlan) => { plan = value; }, setFollowup: (value: SparkHomePlan) => { followup = value; } };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
