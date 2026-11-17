import { describe, expect, test, vi } from "vitest";
import { createToolRegistry } from "../../capabilities/registry.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
} from "../orchestration/role-calls/index.js";
import {
  createWorkerCapabilityBinding,
  type WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import { projectCapabilities } from "../steps/worker-decision/input/canonical-state.js";
import { createExecutionAgentDecisionFormat } from "../steps/execution-agent/format.js";
import { buildExecutionCapabilityCatalogMessage } from "../steps/execution-agent/state-context.js";
import type { ToolRegistry } from "../ports.js";

const requestId = "request-control-documentation";
const controls = {
  type: "object" as const,
  additionalProperties: false as const,
  properties: {
    sources: {
      type: "array" as const,
      items: { type: "string" as const, enum: ["news", "science"] },
      minItems: 0,
      maxItems: 2,
    },
  },
  required: [],
};

async function openWorker() {
  const ledger = createRoleCallLedger({
    requestId,
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 16,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
  for (const command of [
    { authority: "runtime", type: "create_root" },
    {
      authority: "active_role", type: "open_child", callerCallId: "call-1",
      roleId: "worker", objective: "Read the requested records.",
    },
  ]) {
    const result = await ledger.apply({ expectedHead: ledger.current(), command });
    if (!result.ok) throw new Error(result.code);
  }
  const call = ledger.current().state.calls.find(({ roleId }) => roleId === "worker")!;
  return { ledger, call };
}

function createProvider(example: string[]) {
  const registry = createToolRegistry({
    modules: [{
      definition: { name: "reference_reader", routingCapability: "web_lookup" },
      normalInvocation: {
        version: 1,
        operations: [true, false].map((documented) => ({
          operationId: documented ? "read_records" : "read_legacy_records",
          summary: "Read recent records.",
          effect: "read_only" as const,
          approval: "request_policy" as const,
          input: {
            ...controls,
            properties: {
              sources: {
                ...controls.properties.sources,
                ...(documented ? { description: "Optional source filter.", example } : {}),
              },
            },
          },
        })),
      },
      implementation: async () => ({ ok: true, output: "unused", producedNewInformation: false }),
    }],
  });
  const runtimeRegistry: ToolRegistry = {
    listDefinitions: registry.getDefinitions,
    listNormalInvocations: registry.getNormalInvocations,
    getDefinition: registry.getByName,
    hasToolsAvailable: registry.hasToolsAvailable,
    getImplementations: registry.getImplementations,
    execute: async () => { throw new Error("This projection test must not execute a tool."); },
  };
  return createRegisteredToolWorkerCapabilityProvider({
    getRequestToolRegistry: () => runtimeRegistry,
    requestId,
    sessionId: "session-control-documentation",
    abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access",
    nextApprovalId: () => "unused",
  });
}

describe("selected capability control documentation transport", () => {
  test("keeps registry metadata detached through provider, binding and Worker projection", async () => {
    const example = ["news"];
    const provider = createProvider(example);
    const worker = await openWorker();
    const binding = createWorkerCapabilityBinding({
      requestId, context: {}, ...worker, adapters: provider.getAdapters(),
    });
    const projected = projectCapabilities({
      requestId, ...worker, authorityLedger: worker.ledger,
      binding, deferRuntimePathControls: false,
    });
    example.push("science");
    for (const descriptors of [provider.getDescriptors(), binding.capabilities, projected]) {
      const documented = descriptors.find(({ capabilityId }) => capabilityId === "read_records")!;
      expect(documented.controls).toEqual(controls);
      expect(documented.controlDocumentation).toEqual({
        sources: { description: "Optional source filter.", example: ["news"] },
      });
      expect(Object.isFrozen(documented.controlDocumentation)).toBe(true);
      expect(Object.isFrozen(documented.controlDocumentation!.sources)).toBe(true);
      expect(Object.isFrozen(documented.controlDocumentation!.sources!.example)).toBe(true);
      const legacy = descriptors.find(({ capabilityId }) => capabilityId === "read_legacy_records")!;
      expect(legacy.controls).toEqual(controls);
      expect(Object.hasOwn(legacy, "controlDocumentation")).toBe(false);
    }
  });

  test("leaves EA capability catalog and response schema unchanged", () => {
    const documented = createProvider(["news"]).getDescriptors();
    const structural = documented.map(({ controlDocumentation: _documentation, ...descriptor }) => descriptor);
    expect(buildExecutionCapabilityCatalogMessage(documented))
      .toEqual(buildExecutionCapabilityCatalogMessage(structural));
    expect(createExecutionAgentDecisionFormat({ capabilities: documented }))
      .toEqual(createExecutionAgentDecisionFormat({ capabilities: structural }));
    expect(JSON.stringify(buildExecutionCapabilityCatalogMessage(documented)))
      .not.toContain("Optional source filter.");
  });

  test.each<NonNullable<WorkerCapabilityDescriptor["controlDocumentation"]>>([
    { unknown: { description: "Unbound field." } },
    { sources: { example: ["unavailable"] } },
  ])("rejects malformed direct-adapter metadata before execution: %j", async (documentation) => {
    const worker = await openWorker();
    const execute = vi.fn(async () => ({
      outcome: "succeeded" as const, observedEffect: "observation" as const, summary: "unused",
    }));
    const descriptor: WorkerCapabilityDescriptor = {
      capabilityId: "read_records", summary: "Read recent records.", effect: "observation",
      controls, controlDocumentation: documentation,
    };
    expect(() => createWorkerCapabilityBinding({
      requestId, context: {}, ...worker, adapters: [{ descriptor, execute }],
    })).toThrow(/descriptor_control_documentation_/u);
    expect(execute).not.toHaveBeenCalled();
  });
});
