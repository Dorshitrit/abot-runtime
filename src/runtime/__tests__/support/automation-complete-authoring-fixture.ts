import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import type { ToolModuleDeclaration, ToolNormalInvocationOperation, ToolRoutingCapability } from "../../../capabilities/tool-types.js";
import type { AutomationService } from "../../automations/service.js";
import type { RequestExecutionPolicyId } from "../../config/model-execution-policy.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createAutomationDraftToolModule } from "../../capabilities/automations/tool-module.js";
import { createAutomationBuilderToolModule } from "../../capabilities/automation-builder/tool-module.js";
import { createSchedulerRuntimeFixture } from "./scheduler-runtime-fixture.js";

type ManifestCapability = {
  description: string;
  routingCapability: ToolRoutingCapability;
  operations: Record<string, Omit<ToolNormalInvocationOperation, "operationId">>;
};

/** Use maintained public plugin schemas, forbidding future-workflow execution. */
export async function createCompleteAuthoringFixture(policy: RequestExecutionPolicyId = "execution-agent-v1") {
  const executeFutureTool = vi.fn(async () => { throw new Error("authoring_must_not_execute_future_step"); });
  const modules: ToolModuleDeclaration[] = ["local-search", "web", "filesystem"].flatMap((pluginName) => {
    const manifest = JSON.parse(readFileSync(resolve("plugins", pluginName, "plugin.json"), "utf8"));
    const runtime = manifest.extensions["ai.abot.runtime"];
    return Object.entries(runtime.capabilities as Record<string, ManifestCapability>).map(([name, capability]) => ({
      definition: { name, pluginName, description: capability.description,
        routingCapability: capability.routingCapability, catalogGroups: runtime.catalogGroups },
      normalInvocation: { version: 1, operations: Object.entries(capability.operations)
        .map(([operationId, operation]) => ({ ...operation, operationId })) },
      implementation: executeFutureTool,
    }));
  });
  let service: AutomationService | undefined;
  const getService = () => {
    if (!service) throw new Error("authoring_service_not_ready");
    return service;
  };
  const registry = createConfiguredToolRegistry(undefined, [...modules,
    createAutomationDraftToolModule(getService, async () => undefined),
    createAutomationBuilderToolModule(getService, async () => undefined),
  ]);
  const fixture = await createSchedulerRuntimeFixture(policy, undefined, registry);
  service = fixture.application.services.automations!;
  const execute = vi.spyOn(registry, "execute");
  return { ...fixture, registry, execute, executeFutureTool, service };
}

const operation = (toolName: string, operationId: string) => ({ toolName, operationId, contractVersion: 1 });
const literal = (value: string | boolean) => ({ kind: "literal", value });
const output = (nodeId: string, pointer?: string) => ({ kind: "node_result", nodeId,
  select: pointer ? "data" : "text", ...(pointer ? { pointer } : {}) });

export const queriesOutput = { type: "object", additionalProperties: false,
  properties: { queries: { type: "array", minItems: 1, maxItems: 3,
    items: { type: "string", minLength: 1, maxLength: 400 } } }, required: ["queries"] };
export const articleOutput = { type: "object", additionalProperties: false,
  properties: { title: { type: "string", minLength: 1, maxLength: 240 },
    path: { type: "string", minLength: 1, maxLength: 180 },
    summary: { type: "string", minLength: 0, maxLength: 1_000 },
    bodyMarkdown: { type: "string", minLength: 1, maxLength: 4_096 },
    ready: { type: "boolean" } }, required: ["title", "path", "summary", "bodyMarkdown", "ready"] };

/** An authored workflow, not a runtime test script: every dependency is explicit persisted data. */
export function completeAuthoringPlan(modelProfileId: string) {
  const nodes = [
    { as: "inventory", node: { kind: "tool", title: "Find existing article files", onFailure: "stop",
      operation: operation("local_search", "search_local_files"), controls: {
        query: literal(".md"), mode: literal("names"), case_sensitive: literal(false),
      } } },
    { as: "queries", node: { kind: "agent", title: "Plan three distinct searches", onFailure: "stop",
      modelProfileId, agentMode: "reasoning", tools: [],
      roleInstructions: "Plan technology research from the supplied article file inventory; avoid topics already covered.",
      prompt: "Produce one to three search queries for technology reports from the last two days. Do not run searches.",
      inputs: { inventory: { kind: "node_result", nodeId: "$inventory", select: "data" } },
      result: { kind: "json", schema: queriesOutput } } },
    { as: "search", node: { kind: "tool", title: "Run the bounded searches", onFailure: "stop",
      operation: operation("web_search", "search_many"), controls: { queries: output("$queries", "/queries") } } },
    { as: "article", node: { kind: "agent", title: "Write one original article", onFailure: "stop",
      modelProfileId, agentMode: "reasoning", tools: [],
      roleInstructions: "Choose one supported technology topic absent from the article file inventory. Cite sources and distinguish opinion from evidence.",
      prompt: "Write one article based on reports published in the last two days and choose a new Markdown file path. Set ready=false if evidence is insufficient or the topic is already covered. Do not save it yourself.",
      inputs: { inventory: { kind: "node_result", nodeId: "$inventory", select: "data" }, research: output("$search") },
      result: { kind: "json", schema: articleOutput }, acceptance: [{ field: "ready", equals: true }] } },
    { as: "save", node: { kind: "tool", title: "Save the accepted article", onFailure: "stop",
      operation: operation("write_file", "write_complete_file"), controls: {
        path: output("$article", "/path"),
      }, payload: output("$article", "/bodyMarkdown") } },
  ];
  return { version: 1, settings: { objective:
    "Research recent technology with at most three searches and save one original, evidence-based article in a new Markdown file without duplicating existing topics.",
    trigger: { kind: "manual" },
  }, steps: nodes.map(({ as, node }) => {
    const { onFailure: _defaultFailure, ...configured } = node;
    return { key: as, ...configured };
  }) };
}
