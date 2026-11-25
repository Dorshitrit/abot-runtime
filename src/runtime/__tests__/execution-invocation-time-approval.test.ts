import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { successResult } from "../../plugin-sdk/index.js";
import type { SessionRecord } from "../../sessions/types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { captureRequestTemporalContext } from "../context/request-temporal-context.js";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient, RuntimeConfig } from "../ports.js";
import { createExecApprovalScript } from "./support/exec-sensitive-approval-script.js";
import { executionPrefixCachePolicy } from "./support/execution-prefix-cache-fixture.js";
import { makeOwnerControlPeer } from "./support/local-runtime-owner-peer.js";

const cleanup: Array<() => Promise<void>> = [];
const requestId = "approval-clock-request";
const sessionId = "approval-clock-session";
const requestClockKind = "runtime_request_time_v1";
const invocationClockKind = "runtime_invocation_time_v1";
type ModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
type ClockCapsule = { kind: string; currentDateTime: string; timeZone: string };

afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "ea-clock-approval-"));
  cleanup.push(() => rm(rootDir, { recursive: true, force: true }));
  const configPath = join(rootDir, "runner.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 2, models: { defaults: { profileId: "test", steps: {} } },
    context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
    stepDefaults: { timeoutMs: 5000 }, steps: {},
  }));
  const config: RuntimeConfig = {
    runtimeId: "ea-invocation-clock", agentBridgeUrl: "ws://unused", modelGatewayUrl: "http://unused",
    requestRunner: { configPath }, plugins: { enabled: false },
    logging: { enabled: false, rotation: { maxFileSizeMb: 1, maxFiles: 1, maxAgeDays: 1 } },
    paths: {
      rootDir, runtimeDir: join(rootDir, "runtime"), agentWorkDir: join(rootDir, "work"),
      sessionsDir: join(rootDir, "sessions"), attachmentsDir: join(rootDir, "attachments"),
      workspaceDir: join(rootDir, "workspace"), sharedDir: join(rootDir, "shared"),
      compiledDir: join(rootDir, "compiled"), traceFile: join(rootDir, "trace.jsonl"),
    },
    models: { ...executionPrefixCachePolicy, defaults: { profileId: "test", steps: {} } },
    modelExecutionPolicies: { test: { policy: "execution-agent-v1" } },
  };
  const script = createExecApprovalScript("execution-agent-v1",
    [{ capabilityId: "record_effect", controls: {} }], "approval_fixture");
  const countInputTokens = vi.fn<NonNullable<ModelGatewayClient["countInputTokens"]>>(async () => ({
    inputTokens: 1000, profileId: "test", provider: "openai", model: "test",
    contextWindowTokens: 32000, source: "provider_input_token_count",
  }));
  const models = { ...script, countInputTokens };
  const execute = vi.fn(async () => successResult({ output: "The approved fixture action completed." }));
  const module: ToolModuleDeclaration = {
    definition: { name: "invocation_clock_approval", routingCapability: "semantic_mutation", catalogGroups: ["approval_fixture"] },
    normalInvocation: { version: 1, operations: [{
      operationId: "record_effect", summary: "Record one fixture effect.", effect: "mutating", approval: "request_policy",
      input: { type: "object", additionalProperties: false, properties: {}, required: [] },
    }] },
    implementation: execute,
  };
  const peer = makeOwnerControlPeer("clock-approval-view").peer;
  const start = async () => {
    const owner = await createLocalRuntimeOwner(config, {
      models, tools: createConfiguredToolRegistry(config, [module]),
    });
    cleanup.push(async () => { await owner.stop(); await owner.whenIdle?.(); });
    return owner;
  };
  const owner = await start();
  await owner.call("sessions.getOrCreateSession", [sessionId], peer);
  await owner.call("sessions.updateSessionTitle", [sessionId, "Existing conversation"], peer);
  return { config, models, execute, peer, owner, start };
}

function messages(input: ModelInput): readonly ChatMessage[] {
  return input.messages as readonly ChatMessage[];
}

function capsule(input: ModelInput, kind: string): ClockCapsule {
  const matches = messages(input).flatMap(({ content }) => {
    try {
      const value = JSON.parse(content) as ClockCapsule;
      return value.kind === kind ? [value] : [];
    } catch { return []; }
  });
  expect(matches, `exactly one ${kind}`).toHaveLength(1);
  return matches[0]!;
}

test("approval restart retains the request anchor and adds a fresh counted clock only to resumed EA invocations", async () => {
  let now = Date.parse("2026-11-22T08:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = await fixture();
  const outcome = await f.owner.call("request.run", [{
    type: "run_request", requestId, sessionId, text: "Perform one fixture action.",
    toolPermissionMode: "ask", agentMode: "reasoning", modelPreference: { profileId: "test", scope: "all" },
  }, { durableApprovals: true, approvalAvailable: true }], f.peer);
  expect(outcome).toMatchObject({ kind: "awaiting_approval" });
  expect(f.execute).not.toHaveBeenCalled();
  const initialCalls = f.models.invoke.mock.calls.map(([input]) => input)
    .filter(({ modelStep }) => modelStep === "execution.decision");
  expect(initialCalls.length).toBeGreaterThan(0);
  const anchor = capsule(initialCalls[0]!, requestClockKind);
  const initialObservation = capsule(initialCalls[0]!, invocationClockKind);
  expect(initialObservation.currentDateTime).toBe(anchor.currentDateTime);

  const callCountBeforeListing = f.models.invoke.mock.calls.length;
  const pending = await f.owner.call("request.approvals", [sessionId], f.peer) as LocalPendingToolApproval[];
  expect(pending).toHaveLength(1);
  expect(f.models.invoke).toHaveBeenCalledTimes(callCountBeforeListing);
  const sessionPath = join(f.config.paths.sessionsDir, `${sessionId}.json`);
  const parked = JSON.parse(await readFile(sessionPath, "utf8")) as SessionRecord;
  const reference = parked.requests!.find((request) => request.requestId === requestId)!.lifecycle!.wait!.continuation;
  const saved = JSON.parse(await readFile(join(f.config.paths.sessionsDir,
    ".request-continuations", sessionId, `${reference.blob.sha256}.blob`), "utf8"));
  expect(saved.seed.temporalContext).toEqual({ currentDateTime: anchor.currentDateTime, timeZone: anchor.timeZone });
  expect(JSON.stringify(saved.seed)).not.toContain(invocationClockKind);
  expect(JSON.stringify(parked.messages)).not.toContain(invocationClockKind);
  await f.owner.stop();
  await f.owner.whenIdle?.();

  now = Date.parse("2026-11-22T08:07:00Z");
  const restarted = await f.start();
  expect(await restarted.call("request.approvals", [sessionId], f.peer)).toEqual(pending);
  expect(f.models.invoke).toHaveBeenCalledTimes(callCountBeforeListing);
  expect(f.execute).not.toHaveBeenCalled();
  const approval = pending[0]!;
  expect(await restarted.call("request.approval.decide", [{
    sessionId, requestId, approvalId: approval.request.approvalId,
    ...approval.wait!, commandId: "approve-clock-fixture", approved: true,
  }], f.peer)).toEqual({ accepted: true });
  await restarted.whenIdle?.();
  const completed = await restarted.call("sessions.getSessionById", [sessionId], f.peer) as SessionRecord;
  expect(completed.requests?.find((request) => request.requestId === requestId)?.status).toBe("completed");
  expect(completed.messages.filter((message) => message.requestId === requestId && message.role === "user")).toHaveLength(1);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.models.invokeRaw).not.toHaveBeenCalled();
  expect(JSON.stringify(completed.messages)).not.toContain(invocationClockKind);
  const resumed = f.models.invoke.mock.calls.slice(callCountBeforeListing).map(([input]) => input)
    .filter(({ modelStep }) => modelStep === "execution.decision");
  expect(resumed.length).toBeGreaterThan(0);
  const expectedLater = captureRequestTemporalContext({ instant: new Date(now), timeZone: anchor.timeZone });
  for (const input of resumed) {
    expect(capsule(input, requestClockKind)).toEqual(anchor);
    expect(capsule(input, invocationClockKind)).toMatchObject(expectedLater);
    expect(capsule(input, invocationClockKind).currentDateTime).not.toBe(initialObservation.currentDateTime);
  }
  for (const input of [...initialCalls, ...resumed]) {
    expect(messages(input).at(-1)?.role).toBe("system");
    expect(JSON.parse(messages(input).at(-1)!.content)).toMatchObject({ kind: invocationClockKind });
    const counted = f.models.countInputTokens.mock.calls.map(([count]) => count)
      .filter((count) => count.modelStep === input.modelStep);
    expect(counted.some((count) => JSON.stringify(count.messages) === JSON.stringify(input.messages))).toBe(true);
  }
}, 20000);
