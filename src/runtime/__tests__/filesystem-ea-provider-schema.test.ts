import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildOpenAIInputTokenCountPayload, buildOpenAIResponsesPayload } from "../../model-gateway/providers/openai/payload.js";
import type { ModelGatewayJsonSchemaFormat, ModelGatewayRequest } from "../../model-gateway/types.js";
import { resolveRegisteredToolCapabilityCatalog } from "../adapters/registered-tool-worker-capabilities/catalog.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import type { ExecutionAgentDecisionContractOptions } from "../steps/execution-agent/contracts.js";
import { parseExecutionAgentDecisionOutput } from "../steps/execution-agent/decision-parsing.js";
import { createExecutionAgentDecisionFormat } from "../steps/execution-agent/format.js";
import { projectStableExecutionDecisionFormat } from "../steps/execution-agent/stable-decision-format.js";
import { parseStableExecutionAgentDecisionOutput } from "../steps/execution-agent/stable-decision-wire.js";
import { createFullCatalogDecisionFixture } from "./support/execution-full-catalog-fixture.js";
import { executionPrefixCachePolicy } from "./support/execution-prefix-cache-fixture.js";
import { eaFixture } from "./support/filesystem-ea-fixture.js";
import { inlineLocalSchemaReferences } from "./support/inline-local-schema-references.js";

type Schema = Record<string, unknown>;
type Mode = "legacy" | "cached";
let fixture: Awaited<ReturnType<typeof eaFixture>>;
let capabilities: readonly CapabilityDescriptor[];
let contract: ExecutionAgentDecisionContractOptions;

beforeAll(async () => {
  fixture = await eaFixture();
  const request = await fixture.request();
  capabilities = resolveRegisteredToolCapabilityCatalog(request.port, true).descriptors;
  expect(capabilities.map(({ capabilityId }) => capabilityId).sort())
    .toEqual(["create_text", "edit_text", "read_text"]);
  contract = {
    capabilities, capabilityCatalogGroupIds: ["read", "write"],
    activeCapabilityCatalogGroupIds: ["read", "write"], maxBatchCapabilityExecutions: 4,
    eligibleControlsEvidenceExecutionIds: [],
  };
});
afterAll(async () => { await fixture?.dispose(); });
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function formatFor(mode: Mode): ModelGatewayJsonSchemaFormat {
  return mode === "cached"
    ? projectStableExecutionDecisionFormat(contract, capabilities)
    : createExecutionAgentDecisionFormat(contract);
}

function requestFor(format: ModelGatewayJsonSchemaFormat): ModelGatewayRequest {
  return {
    modelStep: "execution.decision", modelPolicy: executionPrefixCachePolicy,
    messages: [{ role: "user", content: "Read and update the requested local file." }],
    promptCacheScope: "filesystem-wire-session", format,
  };
}

function parameters(payload: Record<string, unknown>): Schema {
  const tools = payload.tools as Array<{ type: string; name: string; strict: boolean; parameters: Schema }>;
  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ type: "function", strict: true });
  expect(payload.tool_choice).toEqual({ type: "function", name: tools[0]!.name });
  expect(payload.parallel_tool_calls).toBe(false);
  expect(payload).not.toHaveProperty("text");
  return tools[0]!.parameters;
}

function read(selectionControls: Schema) {
  return { action: "invoke_capability", capabilityId: "read_text", selectionControls };
}

function validate(mode: Mode, decision: Schema, accepted: boolean, runtimeAccepted = accepted) {
  const format = formatFor(mode);
  const wire = parameters(buildOpenAIResponsesPayload(requestFor(format)));
  // The local subset validator deliberately ignores $ref; expand only for value checks.
  const issue = validateJsonSchemaValue(inlineLocalSchemaReferences(wire), { decision });
  if (accepted) expect(issue).toBeUndefined();
  else expect(issue).toBeDefined();
  const text = JSON.stringify({ decision });
  const parsed = mode === "cached"
    ? parseStableExecutionAgentDecisionOutput(text, contract, format)
    : parseExecutionAgentDecisionOutput(text, contract);
  expect(parsed.ok).toBe(runtimeAccepted);
}

const line = {
  path: "app.js", start_line: null, end_line: null, locator: null, context_lines: null,
};
const bytes = { path: "app.js", start_byte: null, max_bytes: null };
const validReads = [
  { name: "default preview", controls: line },
  { name: "byte-capped preview", controls: { ...bytes, max_bytes: 512 } },
  { name: "explicit byte window", controls: { ...bytes, start_byte: 0, max_bytes: 1024 } },
  { name: "line range", controls: { ...line, start_line: 1, end_line: 270, context_lines: 4 } },
  { name: "locator", controls: { ...line, locator: "renderProducts", context_lines: 3 } },
  { name: "existing combined line and locator controls", controls: {
    ...line, start_line: 10, end_line: 50, locator: "renderProducts", context_lines: 3,
  } },
];
const invalidReads = [
  { name: "captured byte cap plus line range", controls: {
    ...line, start_line: 1, end_line: 270, context_lines: 4, max_bytes: 18000,
  } },
  { name: "captured byte offset plus locator", controls: {
    ...line, end_line: 200, locator: "product-detail", context_lines: 2, start_byte: 0, max_bytes: 8000,
  } },
  { name: "missing required target", controls: { ...bytes, path: undefined } },
  { name: "out-of-bounds byte budget", controls: { ...bytes, max_bytes: 24001 } },
  { name: "unknown control", controls: { ...line, content: "not a read selector" } },
];

describe.each(["legacy", "cached"] as const)("filesystem-ea %s OpenAI wire", (mode) => {
  test("retains the official strict subset and identical count/send parameters", () => {
    const format = formatFor(mode);
    const original = JSON.stringify(format);
    const request = requestFor(format);
    const send = buildOpenAIResponsesPayload(request);
    const count = buildOpenAIInputTokenCountPayload(request);
    const schema = parameters(send);
    expect(parameters(count)).toEqual(schema);
    expect(count.input).toEqual(send.input);
    expect(count).not.toHaveProperty("prompt_cache_key");
    expect(schema).toEqual(format.schema);
    assertOpenAIStrictSubset(schema);
    const expanded = inlineLocalSchemaReferences(schema) as {
      properties: { decision: { anyOf: Array<{ properties: Record<string, Schema> }> } };
    };
    const editVariant = expanded.properties.decision.anyOf.find(({ properties }) =>
      (properties.capabilityId?.enum as string[] | undefined)?.includes("edit_text"));
    const ref = (editVariant!.properties.selectionControls!.properties as Record<string, Schema>).range_ref!;
    expect(ref).toMatchObject({ type: "string", minLength: 42, maxLength: 42, pattern: expect.any(String) });
    const pattern = new RegExp(String(ref.pattern), "u");
    const uuid = "e4bbd05e-ac3d-46a9-84d8-b138b4581342";
    expect(pattern.test(`range:${uuid}`)).toBe(true);
    for (const malformed of [uuid, `other:${uuid}`, `range:${uuid.replace("e4bb", "x4bb")}`]) {
      expect(pattern.test(malformed)).toBe(false);
    }
    const readVariant = expanded.properties.decision.anyOf.find(({ properties }) =>
      (properties.capabilityId?.enum as string[] | undefined)?.includes("read_text"));
    const modes = readVariant!.properties.selectionControls!.anyOf as Array<{ properties: Schema }>;
    expect(modes.map(({ properties }) => Object.keys(properties)[0]).sort())
      .toEqual(["context_lines", "max_bytes"]);
    expect(JSON.stringify(format)).toBe(original);
    // Generic declaration constraints must be compiled, never forwarded as unsupported keywords.
    expect(JSON.stringify(schema)).not.toContain('"propertyNames"');
  });

  test.each(validReads)("accepts $name", ({ controls }) => validate(mode, read(controls), true));
  test.each(invalidReads)("rejects $name", ({ controls }) => validate(mode, read(controls), false));

  test("does not expose cross-mode fields even as null transport slots", () => {
    // Existing runtime null normalization still means omission; strict generation
    // has a narrower exact object shape for the selected mode.
    validate(mode, read({ ...bytes, start_byte: 0, start_line: null }), false, true);
  });

  test("uses the same read modes inside observation batches", () => {
    const invocation = (controls: Schema) => ({ capabilityId: "read_text", selectionControls: controls });
    validate(mode, { action: "invoke_capabilities", invocations: [
      invocation(validReads[2]!.controls), invocation(validReads[3]!.controls),
    ] }, true);
    validate(mode, { action: "invoke_capabilities", invocations: [
      invocation(validReads[2]!.controls), invocation(invalidReads[0]!.controls),
    ] }, false);
  });

  test("preserves create/edit targets and keeps mutation controls out of read batches", () => {
    const create = { action: "invoke_capability", capabilityId: "create_text",
      selectionControls: { path: "new.txt" }, operationObjective: "Create the requested document." };
    const edit = { ...create, capabilityId: "edit_text", operationObjective: "Update the observed range.",
      selectionControls: { path: "app.js", range_ref: "range:00000000-0000-4000-8000-000000000001" } };
    validate(mode, create, true);
    validate(mode, edit, true);
    const invalidHex = JSON.stringify({ decision: { ...edit, selectionControls: {
      ...edit.selectionControls, range_ref: "range:0000000z-0000-4000-8000-000000000001",
    } } });
    const parsed = mode === "cached"
      ? parseStableExecutionAgentDecisionOutput(invalidHex, contract, formatFor(mode))
      : parseExecutionAgentDecisionOutput(invalidHex, contract);
    expect(parsed.ok).toBe(false);
    for (const invalid of [
      { ...create, selectionControls: {} },
      { ...create, selectionControls: { path: "new.txt", range_ref: "unexpected" } },
      { ...create, selectionControls: { path: "new.txt", start_byte: 0 } },
      { ...edit, selectionControls: { path: "app.js" } },
      { ...edit, selectionControls: { path: "app.js", range_ref: "" } },
      { ...edit, selectionControls: { path: "app.js", range_ref: "e4bbd05e-ac3d-46a9-84d8-b138b4581342" } },
      { ...edit, selectionControls: { ...edit.selectionControls, end_line: 5 } },
      { ...edit, selectionControls: { ...edit.selectionControls, payload: "not a selection control" } },
    ]) validate(mode, invalid, false);
    validate(mode, { action: "invoke_capabilities", invocations: [
      { capabilityId: "read_text", selectionControls: line },
      { capabilityId: "edit_text", selectionControls: edit.selectionControls },
    ] }, false);
  });
});

test("canonical scope order and later evidence do not change cached filesystem parameters", async () => {
  const first = await createFullCatalogDecisionFixture(capabilities);
  await first.scope("open", ["read"]);
  const readOnly = first.input();
  await first.scope("extend", ["write"]);
  const expanded = first.input();
  const second = await createFullCatalogDecisionFixture([...capabilities].reverse());
  await second.scope("open", ["write", "read"]);
  const sameOffer = second.input();
  const toolsFor = (format: ModelGatewayJsonSchemaFormat) =>
    buildOpenAIResponsesPayload(requestFor(format)).tools;
  expect(toolsFor(readOnly.format)).not.toEqual(toolsFor(expanded.format));
  expect(JSON.stringify(toolsFor(sameOffer.format))).toBe(JSON.stringify(toolsFor(expanded.format)));
  const later = projectStableExecutionDecisionFormat({
    ...expanded.contract, maxBatchCapabilityExecutions: 1,
    eligibleControlsEvidenceExecutionIds: ["later-observation"],
  }, capabilities);
  expect(JSON.stringify(toolsFor(later))).toBe(JSON.stringify(toolsFor(expanded.format)));
  expect(first.request.modelGatewayClient.invoke).not.toHaveBeenCalled();
  expect(first.request.modelGatewayClient.countInputTokens).not.toHaveBeenCalled();
});

/** Offline audit of the documented subset, not a substitute for provider acceptance. */
function assertOpenAIStrictSubset(root: Schema) {
  expect(root.type).toBe("object");
  expect(root).not.toHaveProperty("anyOf");
  let propertyCount = 0;
  let enumCount = 0;
  let stringSize = 0;
  const forbidden = ["propertyNames", "oneOf", "allOf", "not", "if", "then", "else",
    "dependentRequired", "dependentSchemas", "patternProperties", "unevaluatedProperties"];
  function visit(schema: Schema) {
    for (const keyword of forbidden) expect(schema).not.toHaveProperty(keyword);
    if (schema.type === "object") {
      expect(schema.additionalProperties).toBe(false);
      const properties = schema.properties as Record<string, Schema>;
      expect([...(schema.required as string[])].sort()).toEqual(Object.keys(properties).sort());
      propertyCount += Object.keys(properties).length;
      stringSize += Object.keys(properties).join("").length;
      for (const child of Object.values(properties)) visit(child);
    }
    if (schema.$ref !== undefined) {
      expect(typeof schema.$ref).toBe("string");
      expect(String(schema.$ref)).toMatch(/^#\/\$defs\//u);
    }
    if (schema.$defs) {
      const definitions = schema.$defs as Record<string, Schema>;
      stringSize += Object.keys(definitions).join("").length;
      for (const child of Object.values(definitions)) visit(child);
    }
    if (Array.isArray(schema.enum)) {
      enumCount += schema.enum.length;
      stringSize += schema.enum.filter((value) => typeof value === "string").join("").length;
    }
    if (typeof schema.const === "string") stringSize += schema.const.length;
    if (Array.isArray(schema.anyOf)) for (const child of schema.anyOf) visit(child as Schema);
    if (schema.items) visit(schema.items as Schema);
  }
  visit(root);
  expect(propertyCount).toBeLessThanOrEqual(5000);
  expect(enumCount).toBeLessThanOrEqual(1000);
  expect(stringSize).toBeLessThanOrEqual(120000);
  // Expansion also fails on dangling references and measures depth along actual reference paths.
  function depth(schema: Schema, current = 0): number {
    const next = current + (schema.type === "object" ? 1 : 0);
    const children = [
      ...Object.values((schema.properties ?? {}) as Record<string, Schema>),
      ...((schema.anyOf ?? []) as Schema[]),
      ...(schema.items ? [schema.items as Schema] : []),
    ];
    return Math.max(next, ...children.map((child) => depth(child, next)));
  }
  expect(depth(inlineLocalSchemaReferences(root))).toBeLessThanOrEqual(10);
}
