import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildOpenAIResponsesPayload } from "../../model-gateway/providers/openai/payload.js";
import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import { projectCapabilityCatalogGroups } from "../orchestration/capability-adapters/index.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createFullCatalogDecisionFixture, loadFullExecutionCatalog } from "./support/execution-full-catalog-fixture.js";
import { stableDecisionVariants } from "./support/stable-decision-fixture.js";

type Fixture = Awaited<ReturnType<typeof createFullCatalogDecisionFixture>>;
type Input = ReturnType<Fixture["input"]>;
let catalog: ReturnType<typeof loadFullExecutionCatalog>;

beforeAll(() => { catalog = loadFullExecutionCatalog(); });
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function selectedIds(input: Input): string[] {
  return stableDecisionVariants(input.format.schema)
    .flatMap(({ properties }) => properties?.capabilityId?.enum ?? []).sort();
}

function groupIds(capabilities: readonly CapabilityDescriptor[]): string[] {
  return projectCapabilityCatalogGroups(capabilities).map(({ groupId }) => groupId);
}

function expectedIds(capabilities: readonly CapabilityDescriptor[], groups: readonly string[]): string[] {
  return capabilities.filter(({ catalogGroups }) => catalogGroups?.some((group) => groups.includes(group)))
    .map(({ capabilityId }) => capabilityId).sort();
}

function payload(fixture: Fixture, input: Input) {
  return buildOpenAIResponsesPayload({
    modelPolicy: fixture.request.modelPolicy, agentMode: fixture.request.agentMode,
    modelStep: input.modelStep, messages: [...input.messages], format: input.format,
    promptCacheScope: fixture.request.sessionId,
    promptCacheBoundaryBeforeMessageIndex: input.messages.indexOf(input.promptCacheBoundaryBeforeMessage!),
  });
}

function tools(fixture: Fixture, input: Input): unknown {
  return payload(fixture, input).tools;
}

function schemaBytes(input: Input): number {
  return Buffer.byteLength(JSON.stringify(input.format.schema), "utf8");
}

describe("EA cache schemas with the installed default catalog", () => {
  test("discovers the real catalog without exposing unopened controls, then includes only read/write scope", async () => {
    // This is the installed declaration upper bound. Host-specific request preparation
    // may narrow it; no tool handlers or provider token counters run in this fixture.
    expect(catalog.descriptors.length).toBeGreaterThanOrEqual(70);
    expect(catalog.descriptors.map(({ capabilityId }) => capabilityId).sort())
      .toEqual([...catalog.operationIds].sort());
    expect(catalog.operationIds).toEqual(expect.arrayContaining([
      "read_text", "create_text", "edit_text", "list_skills", "create_automation_draft",
      "list_information_sources", "browse_catalog", "run_now",
    ]));
    const fixture = await createFullCatalogDecisionFixture(catalog.descriptors);
    const unopened = fixture.input();
    expect(selectedIds(unopened)).toEqual([]);
    expect(unopened.contract.capabilities).toEqual([]);
    expect(unopened.contract.capabilityCatalogGroupIds).toEqual(groupIds(catalog.descriptors));
    const scopeVariant = stableDecisionVariants(unopened.format.schema)
      .find(({ properties }) => properties?.action?.enum?.includes("open_capability_scope"))!;
    expect(scopeVariant.properties!.catalogGroupIds!.items!.enum)
      .toEqual([...groupIds(catalog.descriptors)].sort());

    await fixture.scope("open", ["read"]);
    const reading = fixture.input();
    expect(selectedIds(reading)).toEqual(expectedIds(catalog.descriptors, ["read"]));
    expect(selectedIds(reading)).toContain("read_text");
    expect(selectedIds(reading)).not.toContain("create_text");
    await fixture.scope("extend", ["write"]);
    const writing = fixture.input();
    expect(selectedIds(writing)).toEqual(expectedIds(catalog.descriptors, ["read", "write"]));
    expect(selectedIds(writing)).toEqual(expect.arrayContaining(["read_text", "create_text", "edit_text"]));
    expect(selectedIds(writing)).not.toContain("browse_catalog");
    expect(JSON.stringify(tools(fixture, writing))).not.toContain('"browse_catalog"');
    expect(fixture.request.modelGatewayClient.invoke).not.toHaveBeenCalled();
    expect(fixture.request.modelGatewayClient.countInputTokens).not.toHaveBeenCalled();
  });

  test("keeps discovery and narrow scopes bounded against the full installed schema", async () => {
    const fixture = await createFullCatalogDecisionFixture(catalog.descriptors);
    const discovery = fixture.input();
    await fixture.scope("open", ["read"]);
    const reading = fixture.input();
    await fixture.scope("extend", ["write"]);
    const writing = fixture.input();
    const full = await createFullCatalogDecisionFixture(catalog.descriptors);
    await full.scope("open", groupIds(catalog.descriptors));
    const fullInput = full.input();
    expect(selectedIds(fullInput)).toEqual([...catalog.operationIds].sort());
    // Bytes are a structural regression guard, not proof of provider-token admission.
    expect(schemaBytes(discovery)).toBeLessThan(20_000);
    expect(schemaBytes(reading)).toBeLessThan(48_000);
    expect(schemaBytes(writing)).toBeLessThan(60_000);
    expect(schemaBytes(writing)).toBeLessThan(schemaBytes(fullInput) * 0.65);
    expect(schemaBytes(discovery)).toBeLessThan(schemaBytes(writing));
  });

  test("bounds initial instructions and the complete payload against inactive policies and all-catalog controls", async () => {
    const fixture = await createFullCatalogDecisionFixture(catalog.descriptors);
    const initial = fixture.input();
    const current = payload(fixture, initial);
    await fixture.scope("open", groupIds(catalog.descriptors));
    // Reproduce the original schema mistake while preserving every initial message.
    const allCatalog = payload(fixture, { ...initial, format: fixture.input().format });
    expect(allCatalog.input).toEqual(current.input);
    expect(current.tools).not.toEqual(allCatalog.tools);
    const initialBytes = Buffer.byteLength(JSON.stringify(current), "utf8");
    const allCatalogBytes = Buffer.byteLength(JSON.stringify(allCatalog), "utf8");
    const firstSystem = initial.messages[0]!;
    expect(firstSystem.role).toBe("system");
    // Corrected fixture: 15,149 wire bytes / 7,670 first-system bytes. HEAD's inactive
    // policy expansion was 34,475 / 26,985; both ceilings reject that regression.
    // These are structural byte limits, not provider tokens or window admission.
    const initialPayloadByteCeiling = 18_000;
    expect(Buffer.byteLength(firstSystem.content, "utf8")).toBeLessThan(9_000);
    expect(initialBytes).toBeLessThan(initialPayloadByteCeiling);
    expect(allCatalogBytes).toBeGreaterThan(initialPayloadByteCeiling);
    expect(fixture.request.modelGatewayClient.invoke).not.toHaveBeenCalled();
    expect(fixture.request.modelGatewayClient.countInputTokens).not.toHaveBeenCalled();
  });

  test("unrelated growth inside an unopened group cannot inflate selected provider tools", async () => {
    const unrelated = catalog.descriptors.find(({ catalogGroups }) =>
      catalogGroups?.includes("scheduling") && !catalogGroups.some((group) => ["read", "write"].includes(group)))!;
    expect(unrelated).toBeDefined();
    const added: CapabilityDescriptor[] = Array.from({ length: 20 }, (_, index) => ({
      ...unrelated, capabilityId: `unopened_extension_${index}`,
      controls: { type: "object", additionalProperties: false,
        properties: { [`extension_field_${index}`]: { type: "string", minLength: 1, maxLength: 4096 } },
        required: [`extension_field_${index}`] },
      selectionControlIds: [`extension_field_${index}`],
    }));
    const expanded = [...catalog.descriptors, ...added];
    expect(groupIds(expanded)).toEqual(groupIds(catalog.descriptors));
    const before = await createFullCatalogDecisionFixture(catalog.descriptors);
    const after = await createFullCatalogDecisionFixture(expanded);
    expect(JSON.stringify(after.input().format)).toBe(JSON.stringify(before.input().format));
    await before.scope("open", ["read", "write"]);
    await after.scope("open", ["read", "write"]);
    const first = before.input(), second = after.input();
    expect(JSON.stringify(second.format)).toBe(JSON.stringify(first.format));
    expect(JSON.stringify(tools(after, second))).toBe(JSON.stringify(tools(before, first)));
    expect(selectedIds(second)).toEqual(expectedIds(catalog.descriptors, ["read", "write"]));
  });
});
