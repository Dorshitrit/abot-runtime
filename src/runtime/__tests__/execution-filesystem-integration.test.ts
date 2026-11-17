import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { RequestToolState } from "../capabilities/request-tool-state.js";
import { loadConfiguredRuntimePlugins, runtimePluginsToToolModules } from "../plugins/loader.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { createRoleCallLedger, ROLE_CALL_OBJECTIVE_MAX_LENGTH, ROLE_CALL_RESULT_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH } from "../orchestration/role-calls/index.js";
import { projectWorkerCapabilityPayloadSourceProvenance } from "../orchestration/worker-capabilities/payload-source-provenance.js";
import type { ModelGatewayClient, ToolPermissionMode } from "../ports.js";
import type { RuntimeModelPluginConfig } from "../config/model-plugin-config.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createTestRequestExecutionScope } from "./support/request-execution-scope.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";
import { partitionCapabilityControlsSchema } from "../orchestration/capability-adapters/index.js";
import { partitionExecutionCapabilityControls } from "../steps/execution-agent/capability-controls-partition.js";
import { parseExecutionAgentDecisionOutput } from "../steps/execution-agent/index.js";
import { refineExecutionCapabilityInvocations } from "../steps/execution-agent/refinement.js";
import { createObservationControlsFixture, observationRefinementCall } from "./support/execution-observation-controls-fixture.js";
import type { WorkerCapabilityAdapterResult, WorkerSettledCapabilityResult } from "../orchestration/worker-capabilities/contracts.js";

const roots: string[] = [];
const states: RequestToolState[] = [];
const FRESHNESS = { token: { kind: "request_steering_v1" as const, version: 0, updates: [] }, isCurrent: () => true };
type FixtureOptions = {
  permission?: ToolPermissionMode;
  state?: unknown;
  pluginIds?: readonly string[];
  globalDeny?: string[];
  modelPlugins?: RuntimeModelPluginConfig;
};
beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  resetDebugLoggerConfig();
  await Promise.all(states.splice(0).map((state) => state.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(policyId: "execution-agent-v1" | "supervisor-worker-v1", includeEa = true, root?: string,
  options: FixtureOptions = {}) {
  if (!root) { root = await mkdtemp(join(tmpdir(), "ea-file-integration-")); roots.push(root); }
  const base = loadPublicRuntimeConfig(options.pluginIds ?? (includeEa ? ["filesystem", "filesystem-ea"] : ["filesystem"]));
  const config = { ...base, paths: { ...base.paths, agentWorkDir: root, workspaceDir: join(root, "workspace") },
    ...(options.globalDeny ? { plugins: { ...base.plugins, deny: options.globalDeny } } : {}),
  };
  await mkdir(config.paths.workspaceDir, { recursive: true });
  const policy = resolveRequestExecutionPolicy(policyId);
  const state = new RequestToolState();
  states.push(state);
  if (options.state) state.restore(options.state);
  const permission = options.permission ?? "full_access";
  const modules = runtimePluginsToToolModules(loadConfiguredRuntimePlugins(config));
  const original = createConfiguredToolRegistry(config, modules);
  const registry = await original.prepareRequest!({
    requestId: "file-integration", rootContractId: policy.rootContract.contractId,
    runtimePathResolver: createRuntimeToolPathResolver(config.paths), requestState: state.port,
  });
  state.assertRestoredStateClaimed();
  const ledger = createRoleCallLedger({ requestId: "file-integration", policy: {
    authority: policy.authority,
    limits: { maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 16,
      maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH, maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
      maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH },
  } });
  const created = await ledger.apply({ expectedHead: ledger.current(), command: { authority: "runtime", type: "create_root" } });
  if (!created.ok) throw new Error(created.code);
  if (policyId === "supervisor-worker-v1") {
    const opened = await ledger.apply({ expectedHead: ledger.current(), command: {
      authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "worker",
      objective: "Write the exact supplied file content.",
    } });
    if (!opened.ok) throw new Error(opened.code);
  }
  const head = ledger.current();
  const call = head.state.calls.find((entry) => entry.callId === head.state.activeCallId)!;
  const assignmentProvenance = call.roleId === "worker"
    ? projectWorkerCapabilityPayloadSourceProvenance({ ledger, head, call }) : undefined;
  const outputs: string[] = [];
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => {
    const text = outputs.shift();
    if (text === undefined) throw new Error("unexpected_model_call");
    return { text, meta: {} };
  });
  const events: { name: string; [key: string]: unknown }[] = [];
  const request = createTestRequestExecutionScope({
    requestId: "file-integration", sessionId: "file-integration-session", prompt: "Write the exact supplied file content.",
    historyMessages: [], shouldGenerateSessionTitle: false, agentMode: "reasoning", toolPermissionMode: permission,
    modelPolicy: { defaults: { profileId: "fixture", steps: {} }, providers: { local: { type: "ollama" } },
      profiles: { fixture: { provider: "local", model: "injected-model", contextWindowTokens: 64000,
        ...(options.modelPlugins ? { plugins: options.modelPlugins } : {}),
      } } },
    runnerConfig: { models: { defaults: { profileId: "fixture", steps: {} } },
      context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
      steps: { "tool_payload.raw": { timeoutMs: 5000 }, "execution.file_payload.raw": { timeoutMs: 5000 } } },
    modelGatewayClient: { invoke, invokeRaw: vi.fn() },
    workerCapabilityProvider: { getDescriptors: () => [], getAdapters: () => [] },
    abortSignal: new AbortController().signal, onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(),
    onEvent: (name, value) => events.push({ name, ...value }),
  }, { executionPolicy: policy });
  const provider = createRequestWorkerCapabilityProvider({ request, runtimeConfig: config,
    executionPolicyAuthority: policy.authority, toolRegistryOverride: registry,
    ...(options.modelPlugins ? { modelPlugins: options.modelPlugins } : {}),
  });
  async function execute(capabilityId: string, controls: Record<string, unknown>, body?: string,
    settledCapabilityResults: readonly WorkerSettledCapabilityResult[] = []) {
    if (body !== undefined) outputs.push(body);
    const adapter = provider.getAdapters().find((entry) => entry.descriptor.capabilityId === capabilityId);
    if (!adapter) throw new Error(`missing_fixture_adapter:${capabilityId}`);
    return adapter.execute({
      context: request.workerCapabilities.executionContext, call,
      ...(assignmentProvenance ? { assignmentProvenance } : {}),
      executionId: `execution-${events.filter(({ name }) => name === "tool.completed").length + 1}`,
      intent: "Perform the selected file operation.",
      ...(body === undefined ? {} : { authoringObjective: "Apply exactly the requested change and preserve other text." }),
      controls, settledCapabilityResults,
      ...(call.roleId === "worker" ? {} : { executionFreshness: FRESHNESS }),
    });
  }
  return { root, provider, invoke, events, execute, call, context: request.workerCapabilities.executionContext, state, outputs };
}

test.each<{ name: string; options: FixtureOptions }>([
  { name: "legacy available", options: {} },
  { name: "legacy model-denied", options: { modelPlugins: { deny: ["filesystem"] },
    globalDeny: ["filesystem.read_file"] } },
  { name: "only EA plugin installed", options: { pluginIds: ["filesystem-ea"] } },
])("composed EA reads directly and creates/edits through one dedicated author: $name", async ({ options }) => {
  const f = await fixture("execution-agent-v1", true, undefined, options);
  expect(f.provider.getDescriptors().map(({ capabilityId }) => capabilityId).sort())
    .toEqual(["create_text", "edit_text", "read_text"]);
  expect(f.provider.getAvailableTools!()!.map(({ toolName }) => toolName).sort())
    .toEqual(["create_text", "edit_text", "read_text"]);
  expect(await f.execute("create_text", { path: "target.txt" }, "alpha\nkeep\n")).toMatchObject({ outcome: "succeeded" });
  const observed = await f.execute("read_text", { path: "target.txt", start_line: 2, end_line: 2 });
  expect(observed).toMatchObject({ outcome: "succeeded" });
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(await f.execute("edit_text", { path: "target.txt", range_ref: readRangeRef(observed) },
    "changed\n",
    [settledRead(observed, "read-1")])).toMatchObject({ outcome: "succeeded" });
  expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("alpha\nchanged\n");
  expect(f.invoke.mock.calls.map(([input]) => input.modelStep))
    .toEqual(["execution.file_payload.raw", "execution.file_payload.raw"]);
  const messages = f.invoke.mock.calls[1]![0].messages as { role: string; content: string }[];
  const source = messages.flatMap(({ content }) => {
    try { return [JSON.parse(content)]; } catch { return []; }
  }).find((value) => value.kind === "execution_file_source_v1");
  expect(source).toMatchObject({ mode: "range", path: "target.txt", sourceText: "keep\n" });
  expect(JSON.stringify(messages)).toContain("keep");
  expect(JSON.stringify(messages)).not.toContain("alpha");
  expect(f.events.filter(({ name }) => name === "tool.payload.started")).toHaveLength(2);
  expect(f.events.filter(({ name }) => name === "tool.completed").map(({ tool }) => tool))
    .toEqual(["create_text", "read_text", "edit_text"]);
});

function settledRead(result: WorkerCapabilityAdapterResult,
  executionId: string): WorkerSettledCapabilityResult {
  if (result.outcome !== "succeeded" || !result.exactResult) throw new Error("expected_successful_read");
  return { executionId, callId: "call-1", invocationAttempt: 1, capabilityId: "read_text",
    declaredEffect: "observation", outcome: result.outcome, observedEffect: result.observedEffect,
    summary: result.summary, referenceData: result.referenceData, references: result.references,
    adapterResult: result.exactResult };
}

function readRangeRef(result: WorkerCapabilityAdapterResult): string {
  if (result.outcome !== "succeeded" || result.exactResult?.kind !== "registered_tool_execution_result_v1")
    throw new Error("expected_successful_read");
  const range = result.exactResult.result.data?.range_ref;
  if (typeof range !== "string") throw new Error("expected_read_range_ref");
  return range;
}

test("EA replaces an explicitly selected earlier window without choosing the latest read or receiving unread content", async () => {
  const f = await fixture("execution-agent-v1");
  const first = "const first = 1;\n";
  const middle = "UNREAD_MIDDLE_" + "x".repeat(30_000) + "\n";
  const last = "const last = 2;\n";
  await writeFile(join(f.root, "target.txt"), first + middle + last);
  const evidence = [];
  let selectedRange = "";
  for (const line of [1, 3]) {
    const result = await f.execute("read_text", { path: "target.txt", start_line: line, end_line: line });
    if (line === 1) selectedRange = readRangeRef(result);
    evidence.push(settledRead(result, `read-${line}`));
  }
  expect(f.invoke).not.toHaveBeenCalled();
  expect(await f.execute("edit_text", { path: "target.txt", range_ref: selectedRange },
    "const first = 10;\n", evidence)).toMatchObject({ outcome: "succeeded" });
  expect(f.invoke).toHaveBeenCalledTimes(1);
  const messages = f.invoke.mock.calls[0]![0].messages as { content: string }[];
  const input = JSON.stringify(messages);
  expect(input).toContain("const first = 1;");
  expect(input).toContain("const last = 2;");
  expect(input).not.toContain("UNREAD_MIDDLE_");
  const source = messages.flatMap(({ content }) => {
    try { return [JSON.parse(content)]; } catch { return []; }
  }).find((value) => value.kind === "execution_file_source_v1");
  expect(source).toMatchObject({ mode: "range", sourceText: first });
  expect(await readFile(join(f.root, "target.txt"), "utf8"))
    .toBe("const first = 10;\n" + middle + last);
});

test.each(["missing", "null", "unknown", "stale"])("EA rejects a %s range before invoking the file author", async (kind) => {
  const f = await fixture("execution-agent-v1");
  await writeFile(join(f.root, "target.txt"), "original\n");
  const observed = await f.execute("read_text", { path: "target.txt" });
  const range_ref = kind === "null" ? null : kind === "unknown" ? "range:unknown" : readRangeRef(observed);
  if (kind === "stale") await writeFile(join(f.root, "target.txt"), "external change\n");
  const controls = { path: "target.txt", ...(kind === "missing" ? {} : { range_ref }) };
  const editing = f.execute("edit_text", controls, "replacement\n", [settledRead(observed, "read-1")]);
  if (kind === "missing" || kind === "null") {
    await expect(editing).rejects.toThrow(kind === "missing"
      ? "effective_controls_required_missing" : "effective_controls_string_invalid");
  } else await expect(editing).resolves.toMatchObject({ outcome: "failed" });
  expect(f.invoke).not.toHaveBeenCalled();
  expect(await readFile(join(f.root, "target.txt"), "utf8"))
    .toBe(kind === "stale" ? "external change\n" : "original\n");
});

test.each<{ name: string; options: FixtureOptions; expected: string[] }>([
  { name: "model plugin deny", options: { modelPlugins: { deny: ["filesystem-ea"] } }, expected: [] },
  { name: "global plugin deny", options: { globalDeny: ["filesystem-ea"] }, expected: [] },
  { name: "model operation deny", options: { modelPlugins: { deny: ["filesystem-ea.edit_text"] } },
    expected: ["create_text", "read_text"] },
  { name: "global operation deny", options: { globalDeny: ["filesystem-ea.create_text"] },
    expected: ["edit_text", "read_text"] },
])("composed EA still honors its own $name without legacy fallback", async ({ options, expected }) => {
  const f = await fixture("execution-agent-v1", true, undefined, options);
  expect(f.provider.getDescriptors().map(({ capabilityId }) => capabilityId).sort()).toEqual(expected);
  expect(f.provider.getAdapters().map(({ descriptor }) => descriptor.capabilityId).sort()).toEqual(expected);
  expect(f.provider.getAvailableTools!()!.map(({ toolName }) => toolName).sort()).toEqual(expected);
  expect(f.invoke).not.toHaveBeenCalled();
});

test("SUPER still honors the legacy plugin model deny with the EA plugin installed", async () => {
  const options = { modelPlugins: { deny: ["filesystem"] } };
  const baseline = await fixture("supervisor-worker-v1", false, undefined, options);
  const actual = await fixture("supervisor-worker-v1", true, baseline.root, options);
  expect(actual.provider.getDescriptors()).toEqual(baseline.provider.getDescriptors());
  expect(actual.provider.getAdapters()).toEqual([]);
  expect(actual.provider.getAvailableTools!()).toEqual(baseline.provider.getAvailableTools!());
  expect(actual.provider.getAvailableTools!()).toEqual([]);
  expect(actual.invoke).not.toHaveBeenCalled();
});

test("installing the EA plugin preserves SUPER catalog and exact legacy payload messages/steps", async () => {
  const baseline = await fixture("supervisor-worker-v1", false);
  const actual = await fixture("supervisor-worker-v1", true, baseline.root);
  expect(actual.provider.getDescriptors()).toEqual(baseline.provider.getDescriptors());
  expect(actual.provider.getAvailableTools!()).toEqual(baseline.provider.getAvailableTools!());
  const output = "unchanged SUPER file author\n";
  expect(await baseline.execute("write_complete_file", { path: "target.txt" }, output))
    .toMatchObject({ outcome: "succeeded" });
  await writeFile(join(baseline.root, "target.txt"), "initial state\n");
  expect(await actual.execute("write_complete_file", { path: "target.txt" }, output))
    .toMatchObject({ outcome: "succeeded" });
  expect(actual.invoke.mock.calls.map(([input]) => ({ step: input.modelStep, messages: input.messages, format: input.format })))
    .toEqual(baseline.invoke.mock.calls.map(([input]) => ({ step: input.modelStep, messages: input.messages, format: input.format })));
  expect(actual.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["tool_payload.raw"]);
  expect(await readFile(join(actual.root, "target.txt"), "utf8")).toBe(output);
});

test("EA selects its required range once without a Controls model turn", async () => {
  const rangeRef = "range:captured-window";
  const f = await fixture("execution-agent-v1");
  const descriptor = f.provider.getDescriptors().find(({ capabilityId }) => capabilityId === "edit_text")!;
  const original = JSON.stringify(descriptor);
  const sharedBefore = partitionCapabilityControlsSchema(descriptor.controls, descriptor.selectionControlIds);
  expect(sharedBefore).toMatchObject({ ok: true, value: {
    selectionSchema: { properties: { path: expect.any(Object), range_ref: expect.any(Object) },
      required: ["path", "range_ref"] },
    remainingSchema: { properties: {} },
  } });
  expect(partitionExecutionCapabilityControls(descriptor)).toMatchObject({ ok: true, value: {
    selectionSchema: { properties: { path: expect.any(Object), range_ref: expect.any(Object) } },
    remainingSchema: { properties: {} },
  } });
  const parsed = parseExecutionAgentDecisionOutput(JSON.stringify({ decision: {
    action: "invoke_capability", capabilityId: "edit_text", operationObjective: "Replace the selected exact source.",
    selectionControls: { path: "target.txt", range_ref: rangeRef },
  } }), { capabilities: [descriptor] });
  expect(parsed).toMatchObject({ ok: true });
  if (!parsed.ok || parsed.decision.action !== "invoke_capability") throw new Error("expected_file_decision");
  const expectedControls = { path: "target.txt", range_ref: rangeRef };
  expect(parsed.decision.selectionControls).toEqual(expectedControls);
  const refinement = createObservationControlsFixture({ additionalDescriptors: [descriptor],
    guidanceByCapability: { edit_text: "Preserve the selected source binding and exact bytes." } });
  expect(await refineExecutionCapabilityInvocations(refinement.request, {
    ...await observationRefinementCall(), capabilities: [descriptor], eligibleSessionArtifactPaths: [],
    steeringSnapshot: refinement.steering.snapshot(), invocations: [parsed.decision],
  })).toMatchObject({ disposition: "execute", invocations: [{ capabilityId: "edit_text", controls: expectedControls,
    authoringObjective: "Replace the selected exact source." }] });
  expect(refinement.invoke).not.toHaveBeenCalled();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(JSON.stringify(descriptor)).toBe(original);
  expect(partitionCapabilityControlsSchema(descriptor.controls, descriptor.selectionControlIds)).toEqual(sharedBefore);
});

test.each([false, true])("saved EA approval restores exact bytes without reauthoring; target changed=%s", async (changed) => {
  const f = await fixture("execution-agent-v1", true, undefined, { permission: "ask" });
  await writeFile(join(f.root, "target.txt"), "original\n");
  const reader = f.provider.getAdapters().find(({ descriptor }) => descriptor.capabilityId === "read_text")!;
  const readPreparation = await reader.prepare!({
    context: f.context, call: f.call, preparationId: "pending-read", controls: { path: "target.txt" },
    settledCapabilityResults: [], executionFreshness: FRESHNESS,
  });
  expect(readPreparation.approvalRequest).toBeDefined();
  readPreparation.applyApprovalDecision!({
    approvalId: readPreparation.approvalRequest!.approvalId, actionFingerprint: readPreparation.actionFingerprint!,
    decision: { approved: true },
  });
  const observed = await readPreparation.execute("approved-read");
  f.outputs.push("approved\n");
  const selected = f.provider.getAdapters().find(({ descriptor }) => descriptor.capabilityId === "edit_text")!;
  const prepared = await selected.prepare!({
    context: f.context, call: f.call, preparationId: "pending-edit",
    controls: { path: "target.txt", range_ref: readRangeRef(observed) },
    authoringObjective: "Replace original with approved.", settledCapabilityResults: [settledRead(observed, "read-1")], executionFreshness: FRESHNESS,
  });
  expect(prepared.approvalRequest).toBeDefined();
  expect(f.invoke).toHaveBeenCalledTimes(1);
  expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("original\n");
  const saved = JSON.parse(JSON.stringify(prepared.snapshot));
  const state = JSON.parse(JSON.stringify(f.state.snapshot()));
  if (changed) await writeFile(join(f.root, "target.txt"), "external edit\n");
  const resumed = await fixture("execution-agent-v1", true, f.root, { permission: "ask", state });
  const restoredAdapter = resumed.provider.getAdapters().find(({ descriptor }) => descriptor.capabilityId === "edit_text")!;
  const restoring = restoredAdapter.restore!({
    context: resumed.context, call: resumed.call, controls: prepared.acceptedControls,
    authoringObjective: "Replace original with approved.", executionFreshness: FRESHNESS,
  }, saved);
  if (changed) {
    await expect(restoring).rejects.toThrow("registered_tool_snapshot_incompatible");
    expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("external edit\n");
    expect(resumed.invoke).not.toHaveBeenCalled();
    return;
  }
  const restored = await restoring;
  expect(restored.approvalRequest).toEqual(prepared.approvalRequest);
  restored.applyApprovalDecision!({
    approvalId: restored.approvalRequest!.approvalId, actionFingerprint: restored.actionFingerprint!,
    decision: { approved: true },
  });
  expect(await restored.execute("restored-edit")).toMatchObject({ outcome: "succeeded" });
  expect(await readFile(join(f.root, "target.txt"), "utf8")).toBe("approved\n");
  expect(resumed.invoke).not.toHaveBeenCalled();
});
