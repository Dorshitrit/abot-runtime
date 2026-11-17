import { describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import {
  createWorkerCapabilityBinding,
  type WorkerCapabilityDescriptor,
} from "../orchestration/worker-capabilities/index.js";
import { buildWorkerDecisionInput } from "../steps/worker-decision/input.js";
import type { WorkerDecisionInputRequest } from "../steps/worker-decision/input/types.js";
import { parseWorkerDecisionOutput } from "../steps/worker-decision/parser.js";
import { prepareWorkerDecisionSession } from "../steps/worker-decision/input/session.js";
import { buildWorkerAssignmentPrompt } from "../steps/worker-decision/input/prompt-context.js";
import { EXECUTION_AGENT_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import {
  createWorkerDecisionModelPolicy,
  createWorkerDecisionRunnerConfig,
} from "./support/worker-decision-model-fixture.js";

const descriptor: WorkerCapabilityDescriptor = {
  capabilityId: "example.inspect",
  summary: "Inspect a bounded source.",
  effect: "observation",
  catalogGroups: ["read"],
  selectionControlIds: ["path"],
  controls: {
    type: "object", additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1, maxLength: 64 },
      query: { type: "string", minLength: 1, maxLength: 64 },
      maxItems: { type: "integer", minimum: 1, maximum: 20 },
      enabled: { type: "boolean" },
    },
    required: ["path", "enabled"],
  },
};
const documented: WorkerCapabilityDescriptor = {
  ...descriptor,
  controlDocumentation: {
    path: { description: "FROZEN_TARGET_DESCRIPTION", example: "example.txt" },
    query: { description: "OPTIONAL_QUERY_DESCRIPTION", example: "sample" },
    maxItems: { description: "MAX_ITEMS_DESCRIPTION", example: 3 },
    enabled: { description: "ENABLE_DESCRIPTION", example: false },
  },
};
const selection = {
  capabilityId: descriptor.capabilityId,
  intent: "Inspect the selected source.",
  selectionControls: { path: "requested.txt" },
  guidance: "",
};

async function fixture(descriptors: readonly WorkerCapabilityDescriptor[]) {
  const request: WorkerDecisionInputRequest = {
    requestId: "controls-reference-request",
    prompt: "Inspect the requested source without filtering.",
    historyMessages: [{ id: "prior-answer", createdAt: "2026-11-15T00:00:00Z", role: "assistant", content: "Earlier settled answer." }],
    agentMode: "reasoning",
    runnerConfig: createWorkerDecisionRunnerConfig(),
    modelPolicy: createWorkerDecisionModelPolicy(32_000, true),
  };
  const ledger = createRoleCallLedger({
    requestId: request.requestId,
    policy: { limits: {
      maxDepth: 4, maxCalls: 8, maxCapabilityExecutions: 8,
      maxObjectiveChars: 4096, maxResultChars: 8192, maxResponseChars: 8192,
    } },
  });
  const root = await ledger.apply({ expectedHead: ledger.current(), command: {
    authority: "runtime", type: "create_root",
  } });
  if (!root.ok) throw new Error(root.code);
  const opened = await ledger.apply({ expectedHead: ledger.current(), command: {
    authority: "active_role", type: "open_child", callerCallId: "call-1",
    roleId: "worker", objective: "Inspect the requested source without filtering.",
  } });
  if (!opened.ok) throw new Error(opened.code);
  const head = ledger.current();
  const call = head.state.calls.find(({ callId }) => callId === head.state.activeCallId)!;
  const execute = vi.fn(async () => ({
    outcome: "succeeded" as const, observedEffect: "observation" as const,
    summary: "Unused adapter result.",
  }));
  const binding = createWorkerCapabilityBinding({
    requestId: request.requestId, ledger, call, context: {},
    adapters: descriptors.map((entry) => ({ descriptor: entry, execute })),
  });
  const options = {
    call,
    requestToolResults: Object.freeze({ sourceRevision: 0, results: Object.freeze([]) }),
    capabilitySource: { ledger, head, binding },
  };
  return { request, options, execute };
}

function capsule(messages: readonly ChatMessage[], kind: string) {
  for (const message of messages) {
    try {
      const value = JSON.parse(message.content);
      if (value?.kind === kind) return value;
    } catch { /* Plain text instructions are not capsules. */ }
  }
  throw new Error(`missing_test_capsule:${kind}`);
}

describe("selected Worker controls input reference", () => {
  test("projects only selected remaining arguments and leaves execution schema unchanged", async () => {
    const other = {
      ...documented, capabilityId: "example.other",
      controlDocumentation: { query: { description: "OTHER_CAPABILITY_DESCRIPTION" } },
    };
    const enriched = await fixture([documented, other]);
    const plain = await fixture([descriptor, { ...descriptor, capabilityId: "example.other" }]);
    const input = buildWorkerDecisionInput(enriched.request, {
      ...enriched.options, selectedCapabilityExecution: selection,
    });
    const baseline = buildWorkerDecisionInput(plain.request, {
      ...plain.options, selectedCapabilityExecution: selection,
    });
    const assignment = capsule(input.context.messages, "runtime_worker_capability_execution_assignment");
    const pending = assignment.pendingCapabilitySelection;
    expect(input.modelStep).toBe("capability.controls");
    expect(pending.capabilityId).toBe(selection.capabilityId);
    expect(pending.selectionControls).toEqual({ path: "requested.txt" });
    expect(pending.remainingControls).toEqual({
      type: "object", additionalProperties: false,
      properties: {
        query: { ...descriptor.controls.properties.query, ...documented.controlDocumentation?.query },
        maxItems: { ...descriptor.controls.properties.maxItems, ...documented.controlDocumentation?.maxItems },
        enabled: { ...descriptor.controls.properties.enabled, ...documented.controlDocumentation?.enabled },
      },
      required: ["enabled"],
    });
    expect(pending.controlsReference).toMatchObject({
      kind: "runtime_capability_controls_input_reference_v1",
      authority: "selected_capability_input_contract",
      responseKeys: expect.stringContaining("Use null for an unset optional argument"),
      examples: expect.stringContaining("not defaults"),
    });
    expect(JSON.stringify(assignment)).not.toContain("FROZEN_TARGET_DESCRIPTION");
    expect(JSON.stringify(assignment)).not.toContain("OTHER_CAPABILITY_DESCRIPTION");
    expect(input.format).toEqual(baseline.format);
    expect(input.context.messages.map(({ role }) => role)).toEqual(baseline.context.messages.map(({ role }) => role));
    expect(input.sharedContextMessages).toEqual(baseline.sharedContextMessages);
    expect(JSON.stringify(input.sharedContextMessages)).not.toContain("controlsReference");
    expect(assignment.objective).toBe(enriched.options.call.objective);
    expect(enriched.execute).not.toHaveBeenCalled();
  });

  test("adding documentation does not change capability selection or its shared evidence input", async () => {
    const plain = await fixture([descriptor]);
    const enriched = await fixture([documented]);
    const before = buildWorkerDecisionInput(plain.request, plain.options);
    const after = buildWorkerDecisionInput(enriched.request, enriched.options);
    expect(after.modelStep).toBe("worker.decision");
    expect(after.context.messages).toEqual(before.context.messages);
    expect(after.sharedContextMessages).toEqual(before.sharedContextMessages);
    expect(after.format).toEqual(before.format);
  });

  test("provides structural reference to legacy capabilities without inventing descriptions", async () => {
    const base = await fixture([descriptor]);
    const input = buildWorkerDecisionInput(base.request, {
      ...base.options, selectedCapabilityExecution: selection,
    });
    const pending = capsule(input.context.messages, "runtime_worker_capability_execution_assignment").pendingCapabilitySelection;
    expect(pending.remainingControls.properties.query).toEqual(descriptor.controls.properties.query);
    expect(pending.remainingControls.required).toEqual(["enabled"]);
    expect(pending.remainingControls.properties.maxItems).not.toHaveProperty("example");
    expect(pending.controlsReference.completeness).toContain("without truncation");
  });

  test("requires the frozen SUPER policy authority before projecting argument reference", async () => {
    const base = await fixture([documented]);
    const session = prepareWorkerDecisionSession(base.request, {
      ...base.options, selectedCapabilityExecution: selection,
    });
    const canonicalSource = session.canonicalState.canonicalSource!;
    const nonSuperSession = {
      ...session,
      canonicalState: {
        ...session.canonicalState,
        canonicalSource: {
          ...canonicalSource,
          head: { ...canonicalSource.head, policy: {
            ...canonicalSource.head.policy,
            authority: EXECUTION_AGENT_V1_EXECUTION_POLICY.authority,
          } },
        },
      },
    };
    const pending = JSON.parse(buildWorkerAssignmentPrompt(nonSuperSession)).pendingCapabilitySelection;
    expect(pending).toEqual({ capabilityId: selection.capabilityId, selectionControls: selection.selectionControls });
    expect(pending).not.toHaveProperty("remainingControls");
    expect(pending).not.toHaveProperty("controlsReference");
  });

  test("binds heterogeneous and repeated selected capabilities to each exact batch slot", async () => {
    const other: WorkerCapabilityDescriptor = {
      capabilityId: "example.count", summary: "Count one source.", effect: "observation",
      catalogGroups: ["read"],
      controls: { type: "object", additionalProperties: false, properties: {
        mode: { type: "string", enum: ["all", "visible"] },
      }, required: ["mode"] },
      controlDocumentation: { mode: { description: "COUNT_MODE_DESCRIPTION", example: "all" } },
    };
    const base = await fixture([documented, other]);
    const invocations = [
      selection,
      { ...selection, selectionControls: { path: "second.txt" } },
      { capabilityId: other.capabilityId, intent: "Count the source.", guidance: "" },
    ];
    const input = buildWorkerDecisionInput(base.request, {
      ...base.options, selectedCapabilityBatchExecution: { invocations },
    });
    const pending = capsule(input.context.messages, "runtime_worker_capability_execution_assignment").pendingCapabilityBatchSelection;
    expect(pending.map((entry: { slot: string }) => entry.slot)).toEqual(["invocation_1", "invocation_2", "invocation_3"]);
    expect(pending.map((entry: { capabilityId: string }) => entry.capabilityId)).toEqual(invocations.map(({ capabilityId }) => capabilityId));
    expect(pending[0].selectionControls).toEqual({ path: "requested.txt" });
    expect(pending[1].selectionControls).toEqual({ path: "second.txt" });
    expect(pending[0].remainingControls).toEqual(pending[1].remainingControls);
    expect(pending[2].remainingControls.properties).toEqual({
      mode: { type: "string", enum: ["all", "visible"], description: "COUNT_MODE_DESCRIPTION", example: "all" },
    });
    expect(JSON.stringify(pending[2])).not.toContain("OPTIONAL_QUERY_DESCRIPTION");
  });

  test("keeps optional null omission and required-null rejection independent of examples", async () => {
    const base = await fixture([documented]);
    const input = buildWorkerDecisionInput(base.request, {
      ...base.options, selectedCapabilityExecution: selection,
    });
    const parse = (enabled: unknown) => parseWorkerDecisionOutput(JSON.stringify({
      decision: { action: "invoke_capability", controls: { query: null, maxItems: 5, enabled } },
    }), undefined, {
      availableCapabilities: input.availableCapabilities,
      decisionPhase: "capability_execution",
      pendingCapabilitySelection: input.pendingCapabilitySelection,
    });
    expect(parse(true)).toMatchObject({ ok: true, decision: {
      controls: { path: "requested.txt", maxItems: 5, enabled: true },
    } });
    const accepted = parse(true);
    if (accepted.ok && accepted.decision.action === "invoke_capability" && "controls" in accepted.decision)
      expect(accepted.decision.controls).not.toHaveProperty("query");
    expect(parse(null)).toMatchObject({ ok: false });
  });
});
