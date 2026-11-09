import { afterEach, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { informationBasketToolContract } from "../capabilities/information-basket/tool-contract.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createSparkHomeReadTools } from "../spark-home/generation/read-tools.js";
import type { SparkHomeAuthoringContext } from "../spark-home/authoring-context/index.js";
import { createHomeGenerationFixture, homeReadTool, deferred } from "./support/spark-home-generation-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import type { SparkHomeRunSnapshot } from "../spark-home/generation/contracts.js";
import { homePlanFormat, parseHomePlan } from "../spark-home/generation/model-contracts.js";

afterEach(disposeCompositionFixtures);

test("catalog excludes mutating, filesystem and unavailable model tools while retaining installed web read tools", async () => {
  const web = homeReadTool();
  const rss = homeReadTool("installed_news_feed");
  const filesystem = homeReadTool("filesystem");
  filesystem.definition.catalogGroups = ["read"];
  const mutate = homeReadTool("mutating_web");
  mutate.normalInvocation = { version: 1, operations: [{ ...mutate.normalInvocation.operations[0], effect: "mutating" }] };
  const registry = createConfiguredToolRegistry(undefined, [web, rss, filesystem, mutate]);
  const reads = await createSparkHomeReadTools({ registry, runId: "home-test", signal: new AbortController().signal,
    mode: "full_access", modelPlugins: { deny: ["web_search"] }, approvals: { requestToolApproval: vi.fn() } });
  expect(reads.descriptors.map(item => item.id)).toEqual(["installed_news_feed:search"]);
  expect(registry.listNormalInvocations?.()).toHaveLength(4);
  await reads.dispose();
});

test("Resources read materializes its bound before preparation and rejects uncaptured sources", async () => {
  const implementation = vi.fn(async (controls: Record<string, unknown>) => ({ ok: true, output: `read:${controls.maxChars}`, producedNewInformation: true }));
  const module: ToolModuleDeclaration = { definition: { name: "information_basket", routingCapability: "semantic_lookup" },
    normalInvocation: informationBasketToolContract, implementation };
  const reads = await createSparkHomeReadTools({ registry: createConfiguredToolRegistry(undefined, [module]), runId: "resource-run",
    signal: new AbortController().signal, mode: "full_access", approvals: { requestToolApproval: vi.fn() } });
  const source = { resourceBindings: [{ sourceId: "indexed", expectedRevision: 2 }] } as unknown as SparkHomeAuthoringContext;
  const selection = { operation: "information_basket:read_information_source", purpose: "Read indexed facts", controls: { sourceId: "indexed", expectedRevision: 2 } };
  const evidence = await reads.read(selection, source);
  expect(evidence).toMatchObject({ outcome: "succeeded", omittedCharacters: 0 });
  expect(implementation).toHaveBeenCalledWith(expect.objectContaining({ sourceId: "indexed", expectedRevision: 2, maxChars: 2000 }), expect.anything());
  await expect(reads.read({ ...selection, controls: { sourceId: "unseen", expectedRevision: 2 } }, source))
    .rejects.toMatchObject({ code: "spark_home_resource_binding_invalid" });
  await expect(reads.read({ ...selection, controls: { sourceId: "indexed", expectedRevision: 2, maxChars: 8000 } }, source))
    .rejects.toMatchObject({ code: "spark_home_resource_read_limit" });
  const repeated = await reads.read(selection, source);
  expect(repeated).toMatchObject({ outcome: "rejected", errorCode: "spark_home_read_repeated" });
  expect(implementation).toHaveBeenCalledTimes(1);
  await reads.dispose();
});

test("normalization cannot redirect a read to an unavailable mutating operation", async () => {
  const source = homeReadTool("web_source");
  source.adapter = { normalizeCall: () => ({ tool: "mutating_target", params: { query: "changed" } }) };
  const target = homeReadTool("mutating_target");
  target.normalInvocation = { version: 1, operations: [{ ...target.normalInvocation.operations[0], effect: "mutating" }] };
  const reads = await createSparkHomeReadTools({ registry: createConfiguredToolRegistry(undefined, [source, target]), runId: "normalized-run",
    signal: new AbortController().signal, mode: "full_access", approvals: { requestToolApproval: vi.fn() } });
  expect(await reads.read({ operation: "web_source:search", purpose: "Read only", controls: { query: "test" } },
    { resourceBindings: [] } as unknown as SparkHomeAuthoringContext)).toMatchObject({ outcome: "rejected" });
  expect(target.implementation).not.toHaveBeenCalled();
  expect(source.implementation).not.toHaveBeenCalled();
  await reads.dispose();
});

test("explicit approval rejection stops HOME publication without replaying or reauthoring the read", async () => {
  const tool = homeReadTool();
  const f = await createHomeGenerationFixture([tool]);
  f.setMode("ask");
  f.setPlan({ direction: "Read a source", reads: [{ operation: "web_search:search", purpose: "Research", controls: { query: "astronomy" } }] });
  const pending = deferred<SparkHomeRunSnapshot>();
  f.service.subscribe(snapshot => { if (snapshot.status === "awaiting_approval") pending.resolve(snapshot); });
  const run = await f.service.start({ expectedSettingsRevision: 1 });
  const approval = await pending.promise;
  await f.service.decideApproval({ runId: run.runId, approvalId: approval.pendingApproval!.approvalId, approved: false, reason: "Skip this request" });
  expect(await f.service.wait(run.runId)).toMatchObject({ status: "failed", errorCode: "spark_home_approval_rejected" });
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(tool.implementation).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled();
});

test("invalid or incomplete model output cannot replace the previous screen", async () => {
  const f = await createHomeGenerationFixture();
  f.invoke.mockResolvedValueOnce({ text: "{}", meta: { providerCompletionReason: "max_output_tokens" } });
  const run = await f.service.start({ expectedSettingsRevision: 1 });
  expect(await f.service.wait(run.runId)).toMatchObject({ status: "failed", errorCode: "output_incomplete" });
  expect(f.update).not.toHaveBeenCalled();
  expect(f.invoke).toHaveBeenCalledTimes(1);
});

test("strict HOME schemas represent optional controls as nullable and decode omissions before canonical validation", () => {
  const operation = informationBasketToolContract.operations.find(item => item.operationId === "read_information_source")!;
  const descriptor = { id: "information_basket:read_information_source", tool: "information_basket", summary: operation.summary, input: operation.input };
  const format = homePlanFormat([descriptor]);
  const schema = format.schema.properties.reads.items;
  expect(schema.anyOf?.[0].properties.controls).toMatchObject({
    required: Object.keys(operation.input.properties),
    properties: { maxChars: { anyOf: expect.arrayContaining([{ type: "null" }]) } },
  });
  const read = { operation: descriptor.id, purpose: "Read source", controls: { sourceId: "known", expectedRevision: 1, startChar: null, maxChars: null } };
  const parsed = parseHomePlan(JSON.stringify({ direction: "Use source", reads: [read] }), [descriptor]);
  expect(parsed.reads[0].controls).toEqual({ sourceId: "known", expectedRevision: 1 });
  expect(() => parseHomePlan(JSON.stringify({ direction: "Use source", reads: [{ ...read, controls: { ...read.controls, sourceId: null } }] }), [descriptor]))
    .toThrow("spark_home_read_controls_invalid");
});
