import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { successResult } from "../../plugin-sdk/index.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createInformationBasketToolModule } from "../capabilities/information-basket/tool-module.js";
import { createKnowledgeSkillsToolModule } from "../capabilities/knowledge-skills/tool-module.js";
import { builtinKnowledgeSkillStore } from "../knowledge-skills/catalog.js";
import type { InformationBasketService } from "../information-basket/contracts.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { handleRunRequest } from "../request/handler.js";
import { createRuntimeConfig, disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { createSnapshotModelScript, SNAPSHOT_FINAL, type SnapshotModelInput, type SnapshotPolicy } from "./support/request-plugin-model-script.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => { await disposeCompositionFixtures(); resetDebugLoggerConfig(); });

const policies: readonly SnapshotPolicy[] = ["supervisor-worker-v1", "execution-agent-v1"];
const basketAction = /information-basket|information_basket|information_sources|information_source|Information Basket|information basket/;

function basketStub(initiallyReady: boolean) {
  let ready = initiallyReady;
  const search = vi.fn<InformationBasketService["search"]>(async () => ({
    status: "empty", sources: [], omittedCount: 0,
  }));
  const readSource = vi.fn<InformationBasketService["readSource"]>();
  const isReady = vi.fn(() => ready);
  const service = {
    isReady, search, readSource, subscribeChanges: () => () => {},
  } as unknown as InformationBasketService;
  return { service, search, readSource, isReady, setReady(value: boolean) { ready = value; } };
}

function unrelatedTool(executed = vi.fn()): ToolModuleDeclaration {
  return {
    definition: { name: "fixture_basic", routingCapability: "semantic_lookup", catalogGroups: ["fixture"] },
    normalInvocation: { version: 1, operations: [{
      operationId: "fixture_basic", summary: "Observe the requested fixture.", effect: "read_only", approval: "always",
      input: { type: "object", additionalProperties: false, properties: {
        channel: { type: "string", enum: ["local"] },
      }, required: ["channel"] },
    }] },
    implementation: async params => {
      executed(params.channel);
      return successResult({ output: "fixture observation" });
    },
  };
}

async function requestFixture() {
  const initial = await createRuntimeConfig();
  await mkdir(initial.paths.agentWorkDir, { recursive: true });
  await writeFile(initial.requestRunner.configPath!, JSON.stringify({
    schemaVersion: 2, models: { defaults: { profileId: "fixture", steps: {} } },
    context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
    stepDefaults: { timeoutMs: 5000 }, steps: {},
  }));
  const config = {
    ...initial, plugins: { enabled: false }, longTermMemory: { enabled: false, emitClientEvents: false },
    models: {
      providers: { local: { type: "ollama" as const } },
      profiles: { fixture: { provider: "local", model: "fixture", contextWindowTokens: 32000 } },
    },
  };
  return {
    async run(policy: SnapshotPolicy, basket?: ReturnType<typeof basketStub>, beforeModel?: (input: SnapshotModelInput) => void | Promise<void>) {
      const executed = vi.fn();
      const readSkill = vi.fn(builtinKnowledgeSkillStore.read);
      const skills = { ...builtinKnowledgeSkillStore, read: readSkill };
      const modules = [unrelatedTool(executed), createKnowledgeSkillsToolModule(skills),
        ...(basket ? [createInformationBasketToolModule(basket.service)] : [])];
      const registry = createConfiguredToolRegistry(config, modules);
      const model = createSnapshotModelScript({ policy, capabilityId: "fixture_basic", channel: "local", beforeModel });
      const sessions = createInMemorySessionStore();
      await sessions.getOrCreateSession("readiness-session");
      await sessions.updateSessionTitle("readiness-session", "Readiness fixture");
      const events: Record<string, unknown>[] = [];
      const ws = { send(data: string) { events.push(JSON.parse(data)); } } as unknown as WebSocket;
      await handleRunRequest(ws, {
        type: "run_request", requestId: "readiness-request", sessionId: "readiness-session",
        input: "Observe the requested fixture.", agentMode: "reasoning", toolPermissionMode: "full_plus",
        modelPreference: { profileId: "fixture", scope: "all" },
      }, {
        runtimeConfig: { ...config, modelExecutionPolicies: { fixture: { policy } } },
        sessionStore: sessions, modelGatewayClient: model, toolRegistry: registry, knowledgeSkillStore: skills,
        ...(basket ? { informationBasket: basket.service } : {}),
      });
      return { model, executed, readSkill, events, session: await sessions.getSessionById("readiness-session") };
    },
  };
}

function topology(inputs: readonly SnapshotModelInput[]) {
  return inputs.map(input => ({
    modelStep: input.modelStep, format: input.format,
    roles: (input.messages as readonly ChatMessage[]).map(message => message.role),
  }));
}

function assertCompleted(result: Awaited<ReturnType<Awaited<ReturnType<typeof requestFixture>>["run"]>>) {
  expect(result.events.some(event => event.type === "failed")).toBe(false);
  expect(result.session!.messages.at(-1)).toMatchObject({ role: "assistant", content: SNAPSHOT_FINAL });
  expect(result.executed).toHaveBeenCalledExactlyOnceWith("local");
  expect(result.readSkill).not.toHaveBeenCalled();
}

function assertBasketSkillMetadata(inputs: readonly SnapshotModelInput[], policy: SnapshotPolicy) {
  const messages = inputs.flatMap(input => input.messages as readonly ChatMessage[]);
  const system = messages.filter(message => message.role === "system").map(message => message.content);
  if (policy === "execution-agent-v1") {
    expect(system.some(content => content.includes("[information-basket]:"))).toBe(true);
    return;
  }
  const catalogs = system.flatMap(content => content.split("\n"))
    .filter(line => line.startsWith("{\"kind\":\"runtime_supervisor_skill_candidates_v1\""))
    .map(line => JSON.parse(line) as { skills: { skillId: string }[] });
  expect(catalogs.some(catalog => catalog.skills.some(skill => skill.skillId === "information-basket"))).toBe(true);
}

test.each(policies)("%s handler keeps unavailable basket out of model inputs without changing ordinary tools", async policy => {
  const f = await requestFixture();
  const baseline = await f.run(policy);
  const basket = basketStub(false);
  const unavailable = await f.run(policy, basket);
  assertCompleted(baseline);
  assertCompleted(unavailable);
  const actual = unavailable.model.invoke.mock.calls.map(([input]) => input);
  const expected = baseline.model.invoke.mock.calls.map(([input]) => input);
  expect(topology(actual)).toEqual(topology(expected));
  expect(JSON.stringify(actual.map(({ messages, format }) => ({ messages, format })))).not.toMatch(basketAction);
  expect(actual.some(input => input.modelStep === (policy === "execution-agent-v1" ? "execution.decision" : "worker.decision"))).toBe(true);
  if (policy === "supervisor-worker-v1") {
    expect(actual.some(input => typeof input.format === "object" && input.format?.name === "supervisor_procedure_gate")).toBe(true);
    expect(actual.some(input => typeof input.format === "object" && input.format?.name === "supervisor_delegation")).toBe(true);
  }
  expect(basket.isReady).toHaveBeenCalledTimes(policy === "execution-agent-v1" ? 1 : 0);
  expect(basket.search).not.toHaveBeenCalled();
  expect(basket.readSource).not.toHaveBeenCalled();
});

test.each(["execution-agent-v1"] as const)("%s keeps a ready basket available after optional search finds no matches", async policy => {
  const f = await requestFixture();
  const basket = basketStub(true);
  const result = await f.run(policy, basket);
  assertCompleted(result);
  expect(basket.search).toHaveBeenCalledOnce();
  const inputs = result.model.invoke.mock.calls.map(([input]) => input);
  assertBasketSkillMetadata(inputs, policy);
  const decisions = inputs.filter(input => input.modelStep === "execution.decision");
  expect(decisions.length).toBeGreaterThan(1);
  expect(JSON.stringify(decisions.at(-1)!.messages)).toContain("information_basket");
  expect(JSON.stringify(inputs.map(input => input.messages))).not.toContain("runtime_information_basket_candidates_v1");
  expect(basket.readSource).not.toHaveBeenCalled();
});

test.each(["execution-agent-v1"] as const)("%s consumes passive matches without reading a source or Skill", async policy => {
  const f = await requestFixture();
  const basket = basketStub(true);
  basket.search.mockResolvedValue({ status: "found", omittedCount: 0, sources: [{
    sourceId: "basket-passive-source", expectedRevision: 1, displayName: "Fixture reference",
    path: "/registered/fixture.md", score: 0.9,
    matches: [{ chunkId: "chunk-0", startChar: 0, endChar: 30 }],
  }] });
  const result = await f.run(policy, basket);
  assertCompleted(result);
  const inputs = result.model.invoke.mock.calls.map(([input]) => input);
  assertBasketSkillMetadata(inputs, policy);
  const basketSelections = inputs.filter(input => typeof input.format === "object" && input.format?.name === "supervisor_basket_selection");
  expect(basketSelections).toHaveLength(0);
  expect(JSON.stringify(inputs.map(input => input.messages))).toContain("runtime_information_basket_candidates_v1");
  expect(result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "event", stage: "information_basket", phase: "discovery_found" }),
  ]));
  expect(basket.search).toHaveBeenCalledOnce();
  expect(basket.readSource).not.toHaveBeenCalled();
  expect(result.readSkill).not.toHaveBeenCalled();
});

test("request preparation snapshots all basket catalog surfaces and preserves unrelated tools", async () => {
  const basket = basketStub(false);
  const base = createConfiguredToolRegistry(undefined, [unrelatedTool(), createInformationBasketToolModule(basket.service)]);
  const hidden = await base.prepareRequest!();
  const assertHidden = (registry: typeof hidden) => {
    expect(registry.listDefinitions().map(tool => tool.name)).toEqual(["fixture_basic"]);
    expect(registry.listNormalInvocations!().map(tool => tool.toolName)).toEqual(["fixture_basic"]);
    expect(registry.getDefinition("information_basket")).toBeUndefined();
    expect(registry.getAdapter!("information_basket")).toBeUndefined();
    expect(Object.keys(registry.getImplementations())).toEqual(["fixture_basic"]);
  };
  assertHidden(hidden);
  basket.setReady(true);
  const available = await base.prepareRequest!();
  assertHidden(hidden);
  expect(available.getDefinition("information_basket")).toBeDefined();
  const operations = available.listNormalInvocations!().find(tool => tool.toolName === "information_basket")!;
  expect(operations.contract.operations.map(operation => operation.operationId)).toEqual([
    "list_information_sources", "search_information_sources", "read_information_source",
  ]);
  expect(Object.keys(available.getImplementations())).toEqual(["fixture_basic", "information_basket"]);
  expect(await available.getImplementations().information_basket!({ action: "search_information_sources", query: "no matches" }))
    .toMatchObject({ ok: true });
  expect(available.getDefinition("information_basket")).toBeDefined();
  basket.setReady(false);
  const next = await base.prepareRequest!();
  assertHidden(next);
  expect(available.getDefinition("information_basket")).toBeDefined();
  expect(available.prepareRequest).toBeUndefined();
  expect(basket.isReady).toHaveBeenCalledTimes(3);
});


test.each(["empty", "found", "pending"] as const)("SUPER stays identical to ordinary routing with a ready %s basket", async state => {
  const f = await requestFixture();
  const baseline = await f.run("supervisor-worker-v1");
  const basket = basketStub(true);
  if (state === "pending") basket.search.mockImplementation(() => new Promise(() => {}));
  if (state === "found") basket.search.mockResolvedValue({ status: "found", omittedCount: 0, sources: [{
    sourceId: "basket-passive-source", expectedRevision: 1, displayName: "PRIVATE SOURCE",
    path: "/registered/fixture.md", score: 0.9, matches: [],
  }] });
  const result = await f.run("supervisor-worker-v1", basket);
  assertCompleted(baseline);
  assertCompleted(result);
  const inputs = result.model.invoke.mock.calls.map(([input]) => input);
  expect(topology(inputs)).toEqual(topology(baseline.model.invoke.mock.calls.map(([input]) => input)));
  expect(JSON.stringify(inputs.map(({ messages, format }) => ({ messages, format })))).not.toMatch(basketAction);
  expect(result.events.some(event => event.stage === "information_basket")).toBe(false);
  expect(basket.search).not.toHaveBeenCalled();
  expect(basket.readSource).not.toHaveBeenCalled();
  expect(basket.isReady).not.toHaveBeenCalled();
});
