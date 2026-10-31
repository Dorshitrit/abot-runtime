import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import type { RegisteredToolNormalInvocation } from "../../../capabilities/tool-types.js";
import type { ModelGatewayClient, ToolRegistry } from "../../ports.js";
import type { RequestContextCompactionStore } from "../../context/semantic-compaction/store.js";
import { createRequestWorkerCapabilityProvider } from "../../request/worker-capability-composition.js";
import { resolveRequestExecutionPolicy } from "../../request/role-executor-composition.js";
import { GENERIC_WORKER_EXECUTOR } from "../../steps/worker-decision/index.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./request-execution-scope.js";
import { runnerConfig, modelPolicy } from "./supervisor-runner-model-phases.js";
import { workerEvidenceReply } from "./worker-evidence-script.js";
import type { dependencyObservationFixture } from "./super-dependency-observation-fixture.js";

type State = Awaited<ReturnType<typeof dependencyObservationFixture>>;
export const CONSUMER_TARGET = "header\nselected current target\nfooter\n";

/** Runs the actual Worker evidence/decision/controls and registered two-stage author. */
export async function createDependencyObservationConsumer(
  root: string,
  state: State,
  store?: RequestContextCompactionStore,
) {
  await writeFile(join(root, "target.txt"), CONSUMER_TARGET);
  const registration = editorRegistration();
  const execute = vi.fn<ToolRegistry["execute"]>(async call => ({
    ok: true, tool: call.tool, output: "Selected target updated.", progress: true,
    producedNewInformation: true, data: { mutationEvidence: true },
    actions: [{ type: "refine_target", target: String(call.params.path) }],
  }));
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: name => name === registration.toolName ? registration.definition : undefined,
    hasToolsAvailable: () => true, getImplementations: () => ({}), execute,
    prepareSharedState: (shared = {}) => ({ ...shared,
      runtimePaths: { rootDir: root, agentWorkDir: root } }),
  };
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async input => {
    if (input.modelStep === "worker.evidence") return workerEvidenceReply(input, true,
      "The selected earlier work supplied the prerequisite observations.", "Apply the requested current edit.");
    if (input.modelStep === "worker.decision") return reply({ action: "invoke_capability",
      capabilityId: "update_target", intent: "Apply the requested current edit.",
      authoringObjective: "Use the selected prerequisite observations in the current edit.",
      selectionControls: { path: "target.txt" } });
    if (input.modelStep === "capability.controls") return reply({ action: "invoke_capability",
      controls: { instruction: "Use the selected observations to replace the current target line." } });
    if (input.modelStep === "tool_payload.raw") return { text: input.format
      ? '{"placement":"replace","start_line":2,"end_line":2}' : "authored replacement", meta: {} };
    throw Error(`unexpected_consumer_model_step:${input.modelStep}`);
  });
  const policy = resolveRequestExecutionPolicy("supervisor-worker-v1");
  const request = createTestRequestExecutionScopeWithCapabilities({
    requestId: state.requestId, sessionId: "dependency-observation-consumer-session", prompt: state.prompt,
    historyMessages: [], shouldGenerateSessionTitle: false,
    runnerConfig, modelPolicy, agentMode: "reasoning", toolPermissionMode: "full_access",
    ...(store ? { contextCompactionStore: store } : {}),
    modelGatewayClient: { invoke, invokeRaw: vi.fn() }, abortSignal: new AbortController().signal,
    onAcknowledgement: vi.fn(), onSessionTitle: vi.fn(async () => undefined),
    onThinkingDelta: vi.fn(), onThinkingTrace: vi.fn(), onAnswerToken: vi.fn(), onEvent: vi.fn(),
  }, view => createRequestWorkerCapabilityProvider({ request: view,
    executionPolicyAuthority: policy.authority, toolRegistryOverride: registry }), { executionPolicy: policy });
  return { request, invoke, execute,
    run: () => GENERIC_WORKER_EXECUTOR.execute({ context: request, ledger: state.ledger,
      call: state.call, availableChildRoleIds: [] }),
  };
}

function reply(decision: unknown) { return { text: JSON.stringify({ decision }), meta: {} }; }

function editorRegistration(): RegisteredToolNormalInvocation {
  const string = { type: "string" as const, minLength: 1, maxLength: 4096 };
  return { toolName: "fixture_edit", definition: {
    name: "fixture_edit", routingCapability: "filesystem_mutation", executionEffect: "mutating",
    params: { path: "string", instruction: "string", selection: "string", content: "string" },
    payloadChannelSpec: { params: ["selection", "content"], outputParam: "content",
      generationMode: "raw_text", targetParam: "path", targetRole: "operation_target", groundingWindow: 1,
      stages: [
        { outputParam: "selection", targetContext: "full_numbered", contextScope: "target_only",
          responseFormat: { type: "object", properties: { placement: { type: "string" },
            start_line: { type: "integer" }, end_line: { type: "integer" } },
            required: ["placement", "start_line", "end_line"] },
          targetLineBoundProperties: ["start_line", "end_line"], promptHint: "Select the current target line." },
        { outputParam: "content", targetContext: "bounded", contextScope: "target_with_artifacts",
          includeMaterializedParams: ["selection"], promptHint: "Author only the selected replacement." },
      ],
    },
  }, contract: { version: 1, operations: [{ operationId: "update_target", summary: "Update one selected target.",
    input: { type: "object", additionalProperties: false, properties: { path: string, instruction: string, selection: string },
      required: ["path", "instruction", "selection"] },
    payload: { kind: "raw_text", param: "content", instructions: "Return the exact raw replacement.", minBytes: 1, maxBytes: 4096 },
    effect: "mutating", approval: "request_policy",
  }] } };
}
