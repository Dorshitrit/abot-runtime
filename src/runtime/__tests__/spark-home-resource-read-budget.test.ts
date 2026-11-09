import { afterEach, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { informationBasketToolContract } from "../capabilities/information-basket/tool-contract.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createSparkHomeReadTools } from "../spark-home/generation/read-tools.js";
import { homePlanFormat, parseHomePlan } from "../spark-home/generation/model-contracts.js";
import { SPARK_HOME_RESOURCE_READ_OPERATION } from "../spark-home/generation/resource-read-budget.js";
import type { SparkHomeAuthoringContext } from "../spark-home/authoring-context/index.js";
import type { SparkHomeReadPlanning } from "../spark-home/generation/contracts.js";
import { createHomeGenerationFixture, homeReadTool } from "./support/spark-home-generation-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

afterEach(disposeCompositionFixtures);

function resourceModule(upstreamMaximum?: number): ToolModuleDeclaration {
  return {
    definition: { name: "information_basket", routingCapability: "semantic_lookup" },
    normalInvocation: { ...informationBasketToolContract, operations: informationBasketToolContract.operations.map(operation => {
      if (operation.operationId !== "read_information_source" || upstreamMaximum === undefined) return operation;
      return { ...operation, input: { ...operation.input, properties: { ...operation.input.properties,
        maxChars: { type: "integer", minimum: 1, maximum: upstreamMaximum } } } };
    }) },
    implementation: vi.fn(async (controls: Record<string, unknown>) => ({ ok: true,
      output: `ACTUAL_RESOURCE_CHARS:${controls.maxChars ?? 8000}`, producedNewInformation: true })),
  };
}

const sources = { resourceBindings: [{ sourceId: "indexed", expectedRevision: 2 }] } as unknown as SparkHomeAuthoringContext;
const selection = (maxChars?: number, startChar = 0) => ({ operation: SPARK_HOME_RESOURCE_READ_OPERATION,
  purpose: "Read indexed evidence", controls: { sourceId: "indexed", expectedRevision: 2, startChar,
    ...(maxChars === undefined ? {} : { maxChars }) } });

async function resourceReads(module = resourceModule()) {
  const registry = createConfiguredToolRegistry(undefined, [module, homeReadTool()]);
  const tools = await createSparkHomeReadTools({ registry, runId: "home-budget-test", signal: new AbortController().signal,
    mode: "full_access", approvals: { requestToolApproval: vi.fn() } });
  return { tools, registry, module };
}

function readMaximum(planning: SparkHomeReadPlanning): unknown {
  const resource = planning.operations.find(operation => operation.id === SPARK_HOME_RESOURCE_READ_OPERATION);
  if (!resource) return undefined;
  return (resource.input.properties as Record<string, { maximum?: number }>).maxChars.maximum;
}

test("HOME projects a 4000-char Resource schema and 3/8000 aggregate budget without changing the generic registry or web reads", async () => {
  const f = await resourceReads();
  try {
    const original = f.registry.listNormalInvocations!();
    const before = JSON.stringify(original);
    const planning = f.tools.planning();
    expect(planning.resourceReadBudget).toMatchObject({ remainingReads: 3, remainingCharacters: 8000,
      maxCharactersPerRead: 4000, defaultCharactersPerRead: 2000 });
    expect(readMaximum(planning)).toBe(4000);
    const schema = homePlanFormat(planning.operations).schema.properties.reads.items.anyOf!
      .find(item => item.properties.operation.enum[0] === SPARK_HOME_RESOURCE_READ_OPERATION)!;
    expect(schema.properties.controls).toMatchObject({ properties: { maxChars: { anyOf: [
      { type: "integer", minimum: 1, maximum: 4000 }, { type: "null" } ] } } });
    expect(() => parseHomePlan(JSON.stringify({ direction: "Read facts", reads: [selection(8000)] }), planning.operations))
      .toThrow("spark_home_read_controls_invalid");
    expect(parseHomePlan(JSON.stringify({ direction: "Read facts", reads: [selection(4000)] }), planning.operations).reads[0].controls.maxChars).toBe(4000);
    expect(planning.operations.find(item => item.id === "web_search:search")?.input)
      .toEqual(original.find(item => item.toolName === "web_search")!.contract.operations[0].input);
    expect(JSON.stringify(f.registry.listNormalInvocations!())).toBe(before);
  } finally { await f.tools.dispose(); }
});

test("remaining capacity is shared by the next phase schema and exact controls, including an omitted near-end default", async () => {
  const f = await resourceReads();
  try {
    await f.tools.read(selection(4000), sources);
    expect(f.tools.planning().resourceReadBudget).toMatchObject({ remainingReads: 2, remainingCharacters: 4000, maxCharactersPerRead: 4000 });
    await f.tools.read(selection(3000, 4000), sources);
    const remaining = f.tools.planning();
    expect(remaining.resourceReadBudget).toMatchObject({ remainingReads: 1, remainingCharacters: 1000,
      maxCharactersPerRead: 1000, defaultCharactersPerRead: 1000 });
    expect(readMaximum(remaining)).toBe(1000);
    await expect(f.tools.read(selection(1001, 7000), sources)).rejects.toMatchObject({ code: "spark_home_resource_read_limit" });
    const evidence = await f.tools.read(selection(undefined, 7000), sources);
    expect(evidence).toMatchObject({ outcome: "succeeded", output: JSON.stringify({ output: "ACTUAL_RESOURCE_CHARS:1000" }) });
    expect(f.module.implementation).toHaveBeenLastCalledWith(expect.objectContaining({ maxChars: 1000, startChar: 7000 }), expect.anything());
    expect(f.tools.planning().resourceReadBudget).toMatchObject({ remainingReads: 0, remainingCharacters: 0, maxCharactersPerRead: 0 });
    expect(readMaximum(f.tools.planning())).toBeUndefined();
    expect(f.tools.planning().operations.some(item => item.id === "web_search:search")).toBe(true);
    await expect(f.tools.read(selection(undefined, 8000), sources)).rejects.toMatchObject({ code: "spark_home_resource_read_limit" });
  } finally { await f.tools.dispose(); }
});

test.each([
  { count: 3, chars: 1000, remainingReads: 0, remainingCharacters: 5000 },
  { count: 2, chars: 4000, remainingReads: 1, remainingCharacters: 0 },
])("Resource reads disappear when either bound is exhausted: $count reads of $chars chars", async expected => {
  const f = await resourceReads();
  try {
    for (let index = 0; index < expected.count; index++) await f.tools.read(selection(expected.chars, index * expected.chars), sources);
    expect(f.tools.planning().resourceReadBudget).toMatchObject({ remainingReads: expected.remainingReads,
      remainingCharacters: expected.remainingCharacters, maxCharactersPerRead: 0 });
    expect(readMaximum(f.tools.planning())).toBeUndefined();
    expect(f.tools.descriptors.some(item => item.id === "web_search:search")).toBe(true);
  } finally { await f.tools.dispose(); }
});

test("a stricter upstream Resource limit also bounds the advertised schema and omitted execution controls", async () => {
  const f = await resourceReads(resourceModule(1500));
  try {
    expect(readMaximum(f.tools.planning())).toBe(1500);
    expect(f.tools.planning().resourceReadBudget.defaultCharactersPerRead).toBe(1500);
    expect(await f.tools.read(selection(), sources)).toMatchObject({ output: JSON.stringify({ output: "ACTUAL_RESOURCE_CHARS:1500" }) });
  } finally { await f.tools.dispose(); }
});

test("actual HOME model calls get fresh passive phase budgets; HTML receives receipts without the planning budget", async () => {
  const module = resourceModule();
  const f = await createHomeGenerationFixture([module]);
  f.context.capture.mockResolvedValue({ ...f.sources, resourceBindings: sources.resourceBindings });
  f.setPlan({ direction: "Read one source", reads: [selection(4000)] });
  f.setFollowup({ direction: "Use bounded followup evidence", reads: [selection(undefined, 4000)] });
  const run = await f.service.start({ expectedSettingsRevision: 1 });
  expect(await f.service.wait(run.runId)).toMatchObject({ status: "completed" });
  const messages = f.invoke.mock.calls.map(([call]) => call.messages as ChatMessage[]);
  const references = messages.map(items => JSON.parse(items[2].content));
  for (const reference of references.slice(0, 2)) {
    expect(reference).toMatchObject({ authority: "passive_reference", addsUserIntent: false, grantsActionAuthority: false });
    expect(reference.reference.resourceReadBudget).toMatchObject({ kind: "spark_home_resource_read_budget_v1",
      authority: "passive_runtime_state", applicability: "this_home_planning_phase_only", addsUserIntent: false, grantsActionAuthority: false });
  }
  expect(references[0].reference.resourceReadBudget).toMatchObject({ remainingReads: 3, remainingCharacters: 8000 });
  expect(references[1].reference.resourceReadBudget).toMatchObject({ remainingReads: 2, remainingCharacters: 4000 });
  expect(references[1].reference.evidence[0]).toMatchObject({ outcome: "succeeded", output: JSON.stringify({ output: "ACTUAL_RESOURCE_CHARS:4000" }) });
  expect(references[2].reference).not.toHaveProperty("resourceReadBudget");
  expect(references[2].reference.evidence.map((item: { output: string }) => JSON.parse(item.output).output)).toEqual([
    "ACTUAL_RESOURCE_CHARS:4000", "ACTUAL_RESOURCE_CHARS:2000" ]);
  expect(messages.map(items => items.map(item => item.role))).toEqual(Array(3).fill(["system", "user", "user"]));
  expect(messages.map(items => items[1].content)).toEqual(Array(3).fill(messages[0][1].content));
});
