import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredToolNormalInvocation, ToolPayloadChannelSpec } from "../../capabilities/tool-types.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { RoleCallFrame } from "../orchestration/role-calls/index.js";
import type { WorkerCapabilityPayloadModelPort } from "../orchestration/worker-capabilities/index.js";
import type { ToolRegistry } from "../ports.js";
import { createTestWorkerCapabilityPayloadAuthor } from "./support/worker-payload-author.js";

type Principal = "root" | "worker";
type PayloadRoute = "single_spec" | "single_stage" | "raw" | "undeclared" | "two_stage";
const structuredFormat = {
  type: "object", additionalProperties: false,
  properties: { label: { type: "string", minLength: 1 }, count: { type: "integer", minimum: 1 } },
  required: ["label", "count"],
};
const selectionFormat = {
  type: "object", additionalProperties: false,
  properties: { slot: { type: "integer", minimum: 1 } }, required: ["slot"],
};
const rawBody = '  {"incomplete":\n';
const validBody = ' { "label": "requested result", "count": 2 } ';
const canonicalBody = JSON.stringify(JSON.parse(validBody));
const assignment = "Produce the requested exact payload for this operation.";
const steering = { kind: "request_steering_v1" as const, version: 0, updates: [] };

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function call(principal: Principal): RoleCallFrame {
  return {
    callId: principal === "root" ? "call-1" : "call-2",
    parentCallId: principal === "root" ? null : "call-1",
    roleId: principal === "root" ? "supervisor" : "worker",
    depth: principal === "root" ? 0 : 1,
    objective: principal === "root" ? null : assignment,
    dependencyResultRefs: [], status: "active", childCallIds: [], activationCount: 1, resultRef: null,
  };
}

function payloadSpec(route: Exclude<PayloadRoute, "raw">): ToolPayloadChannelSpec {
  const base: ToolPayloadChannelSpec = {
    params: ["body"], outputParam: "body", generationMode: "raw_text",
  };
  if (route === "undeclared") return { ...base, responseFormat: structuredFormat };
  if (route === "single_spec") return {
    ...base, responseFormat: structuredFormat, stages: [{ outputParam: "body" }],
  };
  if (route === "single_stage") return {
    ...base, stages: [{ outputParam: "body", responseFormat: structuredFormat }],
  };
  return {
    ...base, params: ["selection", "body"], stages: [
      { outputParam: "selection", responseFormat: selectionFormat, promptHint: "Return the requested selection." },
      { outputParam: "body", includeMaterializedParams: ["selection"] },
    ],
  };
}

function registration(route: PayloadRoute): RegisteredToolNormalInvocation {
  const twoStages = route === "two_stage";
  return {
    toolName: "neutral_payload_sink",
    definition: {
      name: "neutral_payload_sink", routingCapability: "filesystem_mutation", executionEffect: "mutating",
      params: { instruction: "string", body: "string", ...(twoStages ? { selection: "string" } : {}) },
      ...(route === "raw" ? {} : { payloadChannelSpec: payloadSpec(route) }),
    },
    contract: { version: 1, operations: [{
      operationId: "submit_neutral_payload", summary: "Submit one exact authored payload.",
      effect: "mutating", approval: "request_policy",
      input: {
        type: "object", additionalProperties: false,
        properties: {
          instruction: { type: "string", minLength: 1, maxLength: 256 },
          ...(twoStages ? { selection: { type: "string" as const, minLength: 1, maxLength: 256 } } : {}),
        },
        required: twoStages ? ["instruction", "selection"] : ["instruction"],
      },
      payload: { kind: "raw_text", param: "body", instructions: "Return the requested complete payload.", minBytes: 1, maxBytes: 1_024 },
    }] },
  };
}

function fixture(principal: Principal, route: PayloadRoute, outputs: readonly string[], allowRoot = true) {
  const registered = registration(route);
  const execute = vi.fn<ToolRegistry["execute"]>(async () => ({
    ok: true, tool: registered.toolName, output: "accepted", producedNewInformation: true, data: { mutationEvidence: true },
  }));
  const registry: ToolRegistry = {
    listDefinitions: () => [registered.definition], listNormalInvocations: () => [registered],
    getDefinition: (name) => name === registered.toolName ? registered.definition : undefined,
    hasToolsAvailable: () => true, getImplementations: () => ({}), execute,
  };
  let nextOutput = 0;
  const invoke = vi.fn<WorkerCapabilityPayloadModelPort["invoke"]>(async () => {
    const output = outputs[nextOutput++];
    if (output === undefined) throw new Error("unexpected_extra_payload_model_call");
    return output;
  });
  const requestId = `single-stage-${principal}-${route}`;
  const abortSignal = new AbortController().signal;
  const payloadAuthor = createTestWorkerCapabilityPayloadAuthor({
    requestId, abortSignal, model: { invoke }, capabilityAuthorities: allowRoot ? ["root", "worker"] : ["worker"],
  });
  const onEvent = vi.fn();
  const provider = createRegisteredToolWorkerCapabilityProvider<Record<string, never>>({
    getRequestToolRegistry: () => registry, requestId, sessionId: `${requestId}-session`,
    abortSignal, toolPermissionMode: "full_access", nextApprovalId: () => "unused-approval", payloadAuthor, onEvent,
  });
  const adapter = provider.getAdapters()[0]!;
  return {
    execute, invoke, onEvent, descriptor: adapter.descriptor,
    run: () => adapter.execute({
      context: {}, call: call(principal), executionId: "capability-execution-1",
      intent: "Submit the requested payload.", controls: { instruction: assignment }, settledCapabilityResults: [],
      authoringObjective: assignment,
      ...(principal === "root" ? {
        executionFreshness: { token: steering, isCurrent: () => true },
      } : {}),
    }),
  };
}

function assertPrincipal(request: Parameters<WorkerCapabilityPayloadModelPort["invoke"]>[0], principal: Principal) {
  if (principal === "root") {
    expect(request.context).toMatchObject({ root: {
      callId: "call-1", objectiveSource: "runtime_request_source_plus_steering_v1", steeringVersion: 0,
    } });
    expect(request.context).not.toHaveProperty("worker");
    expect(request.context.acceptedCapability).toHaveProperty("authoringObjective", assignment);
    return;
  }
  expect(request.context).toMatchObject({ worker: { callId: "call-2", parentCallId: "call-1", objective: assignment } });
  expect(request.context).not.toHaveProperty("root");
  expect(request.context.acceptedCapability).toHaveProperty("authoringObjective", assignment);
}

describe.each<Principal>(["root", "worker"])("registered payload stage bridge for %s", (principal) => {
  it.each<PayloadRoute>(["single_spec", "single_stage"])("passes the exact declared schema through the adapter and real author (%s)", async (route) => {
    const { run, invoke, execute } = fixture(principal, route, [validBody]);
    const result = await run();
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "succeeded", observedEffect: "mutation" });
    expect(invoke).toHaveBeenCalledOnce();
    const request = invoke.mock.calls[0]![0];
    expect(request.responseFormat).toEqual(structuredFormat);
    expect(request.context).toMatchObject({
      acceptedCapability: { capabilityId: "submit_neutral_payload", controls: { instruction: assignment } },
      payloadStage: { index: 1, count: 1, outputParam: "body" },
      payloadContract: { responseFormat: structuredFormat },
    });
    assertPrincipal(request, principal);
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      tool: "neutral_payload_sink", params: { instruction: assignment, body: canonicalBody },
    }, expect.any(Object));
  });

  it.each([
    { label: "malformed JSON", body: '{"label":"requested result","count":2' },
    { label: "schema-invalid JSON", body: '{"label":"requested result","count":"two"}' },
    { label: "duplicate-member JSON", body: '{"label":"discarded","label":"requested result","count":2}' },
  ])("rejects $label before executing the tool", async ({ body }) => {
    const { run, invoke, execute, onEvent } = fixture(principal, "single_stage", [body]);
    await expect(run()).resolves.toMatchObject({ outcome: "failed", observedEffect: "none" });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]![0].responseFormat).toEqual(structuredFormat);
    expect(execute).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenLastCalledWith("tool.payload.failed", expect.objectContaining({
      payloadStage: 1, outputParam: "body", error: "payload_model_output_invalid",
    }));
  });

  it.each<PayloadRoute>(["raw", "undeclared"])("keeps the route without declared stages literal (%s)", async (route) => {
    const { run, invoke, execute } = fixture(principal, route, [rawBody]);
    const result = await run();
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "succeeded", observedEffect: "mutation" });
    expect(invoke).toHaveBeenCalledOnce();
    const request = invoke.mock.calls[0]![0];
    expect(request.responseFormat).toBeUndefined();
    expect(request.context).not.toHaveProperty("payloadStage");
    assertPrincipal(request, principal);
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      tool: "neutral_payload_sink", params: { instruction: assignment, body: rawBody },
    }, expect.any(Object));
  });

  it("preserves two-stage selection ordering and passes its materialized value to the final raw stage", async () => {
    const { run, invoke, execute, descriptor } = fixture(principal, "two_stage", [' { "slot": 2 } ', rawBody]);
    expect(descriptor.controls.required).toEqual(["instruction"]);
    expect(descriptor.controls.properties).not.toHaveProperty("selection");
    const result = await run();
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "succeeded", observedEffect: "mutation" });
    expect(invoke).toHaveBeenCalledTimes(2);
    const first = invoke.mock.calls[0]![0];
    const second = invoke.mock.calls[1]![0];
    expect(first.responseFormat).toEqual(selectionFormat);
    expect(first.context).toMatchObject({ payloadStage: { index: 1, count: 2, outputParam: "selection" } });
    expect(second.responseFormat).toBeUndefined();
    expect(second.context).toMatchObject({
      payloadStage: { index: 2, count: 2, outputParam: "body" }, materializedParams: { selection: '{"slot":2}' },
    });
    assertPrincipal(first, principal);
    assertPrincipal(second, principal);
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      tool: "neutral_payload_sink", params: { instruction: assignment, selection: '{"slot":2}', body: rawBody },
    }, expect.any(Object));
  });
});

it("does not let a single declared stage grant payload authority to an unauthorized root", async () => {
  const { run, invoke, execute } = fixture("root", "single_stage", [validBody], false);
  await expect(run()).resolves.toMatchObject({ outcome: "failed", observedEffect: "none" });
  expect(invoke).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});
