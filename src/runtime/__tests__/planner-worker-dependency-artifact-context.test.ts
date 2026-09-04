import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { resolveRegisteredToolPayloadRelatedArtifactContexts } from "../adapters/registered-tool-payload-related-artifacts.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import {
  createRoleCallLedger,
  ROLE_CALL_OBJECTIVE_MAX_LENGTH,
  ROLE_CALL_RESPONSE_MAX_LENGTH,
  ROLE_CALL_RESULT_MAX_LENGTH,
  type RoleCallLedger,
  type RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import {
  createWorkerCapabilityBinding,
  type WorkerCapabilityPayloadAuthor,
} from "../orchestration/worker-capabilities/index.js";
import type { ToolRegistry } from "../ports.js";
import type {
  RegisteredToolNormalInvocation,
  ToolExecutionResult,
  ToolNormalInvocationOperation,
} from "../../capabilities/tool-types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Planner Worker dependency artifact context", () => {
  test("projects only mechanically linked sibling artifacts into target_with_artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "planner-worker-artifacts-"));
    temporaryRoots.push(root);
    await mkdir(join(root, "Project"), { recursive: true });
    const unrelatedContent = "export const unrelated = true;\n";
    const htmlContent = '<main id="product-grid"></main>\n';
    await Promise.all([
      writeFile(join(root, "Project/unrelated.js"), unrelatedContent, "utf8"),
      writeFile(join(root, "Project/index.html"), htmlContent, "utf8"),
    ]);

    const ledger = createLedger();
    await commit(ledger, { authority: "runtime", type: "create_root" });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Create an unrelated JavaScript artifact.",
    });
    await settleArtifactCapability(
      ledger,
      "call-2",
      "Project/unrelated.js",
      "Created the unrelated JavaScript artifact.",
    );
    await returnChild(
      ledger,
      "call-1",
      "call-2",
      "The unrelated JavaScript artifact is complete.",
    );
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "planner",
      objective: "Build connected project artifacts.",
    });
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-3",
      roleId: "worker",
      objective: "Create the HTML structure.",
      plannerPlan: {
        mode: "declare",
        plan: {
          summary: "Create the HTML structure and then the CSS.",
          items: [
            {
              title: "Create HTML",
              objective: "Create the HTML structure.",
            },
            {
              title: "Create CSS",
              objective: "Style the exact established HTML structure.",
            },
          ],
        },
        selectedItemIndexes: [0],
      },
    });
    await settleArtifactCapability(
      ledger,
      "call-4",
      "Project/index.html",
      "Created the HTML structure.",
    );
    await returnChild(
      ledger,
      "call-3",
      "call-4",
      "The HTML structure is complete.",
    );
    await commit(ledger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-3",
      roleId: "worker",
      objective: "Style the exact established HTML structure.",
      dependencyResultRefs: ["result-2"],
      plannerPlan: {
        mode: "select",
        itemIds: ["plan-call-3-item-2"],
      },
    });
    const call = ledger
      .current()
      .state.calls.find(({ callId }) => callId === "call-5");
    if (!call) throw new Error("Current Planner Worker call missing");
    const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
      async (input) => {
        expect(input.relatedArtifactContexts).toEqual([
          {
            sourceExecutionId: "capability-execution-2",
            targetPath: "Project/index.html",
            presentation: "full",
            content: htmlContent,
          },
        ]);
        return { status: "authored" as const, body: "main { display: grid; }" };
      },
    );
    const provider = createDependencyArtifactProvider(root, author);
    const binding = createWorkerCapabilityBinding({
      requestId: "planner-worker-artifact-context",
      context: Object.freeze({}),
      call,
      ledger,
      adapters: provider.getAdapters(),
    });
    await expect(
      binding.execute({
        capabilityId: "write_complete_file",
        intent: "Create the stylesheet.",
        authoringObjective: "Author the complete stylesheet body.",
        controls: { path: "Project/style.css" },
      }),
    ).resolves.toEqual({ executionId: "capability-execution-3" });
    expect(author).toHaveBeenCalledOnce();

    const assignmentProvenance = author.mock.calls[0]![0].assignmentProvenance;
    if (!assignmentProvenance) {
      throw new Error("Planner Worker assignment provenance missing");
    }

    const common = {
      targetParam: "path",
      controls: Object.freeze({ path: "Project/style.css" }),
      sharedState: Object.freeze({
        runtimePaths: Object.freeze({ agentWorkDir: root }),
      }),
      call,
      assignmentProvenance,
      settledCapabilityResults: Object.freeze([]),
    };
    for (const contextScope of ["standard", "target_only"] as const) {
      await expect(
        resolveRegisteredToolPayloadRelatedArtifactContexts({
          ...common,
          contextScope,
        }),
      ).resolves.toEqual([]);
    }
    const requestLedger = createLedger();
    await commit(requestLedger, { authority: "runtime", type: "create_root" });
    await commit(requestLedger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Create the request dependency artifact.",
    });
    await settleArtifactCapability(
      requestLedger,
      "call-2",
      "Project/index.html",
      "Created the request dependency artifact.",
    );
    await returnChild(
      requestLedger,
      "call-1",
      "call-2",
      "The request dependency artifact is complete.",
    );
    const requestHead = await commit(requestLedger, {
      authority: "active_role",
      type: "open_child",
      callerCallId: "call-1",
      roleId: "worker",
      objective: "Create one request-scoped stylesheet.",
      dependencyResultRefs: ["result-1"],
    });
    const requestCall = requestHead.state.calls.find(
      ({ callId }) => callId === requestHead.state.activeCallId,
    );
    if (!requestCall) throw new Error("Request-scoped Worker call missing");
    const requestAuthor = vi.fn<WorkerCapabilityPayloadAuthor["author"]>(
      async () => ({
        status: "authored" as const,
        body: "main { display: block; }",
      }),
    );
    const requestBinding = createWorkerCapabilityBinding({
      requestId: "planner-worker-artifact-context",
      context: Object.freeze({}),
      call: requestCall,
      ledger: requestLedger,
      adapters: createDependencyArtifactProvider(
        root,
        requestAuthor,
      ).getAdapters(),
    });
    await requestBinding.execute({
      capabilityId: "write_complete_file",
      intent: "Create the request-scoped stylesheet.",
      authoringObjective: "Author the complete request-scoped stylesheet.",
      controls: { path: "Project/request.css" },
    });
    const requestProvenance =
      requestAuthor.mock.calls[0]?.[0].assignmentProvenance;
    if (!requestProvenance) {
      throw new Error("Request-scoped Worker provenance missing");
    }
    expect(
      requestAuthor.mock.calls[0]?.[0].relatedArtifactContexts,
    ).toBeUndefined();
    await expect(
      resolveRegisteredToolPayloadRelatedArtifactContexts({
        ...common,
        call: requestCall,
        contextScope: "target_with_artifacts",
        assignmentProvenance: requestProvenance,
      }),
    ).resolves.toEqual([]);
  });
});

function createLedger(): RoleCallLedger {
  return createRoleCallLedger({
    requestId: "planner-worker-artifact-context",
    policy: {
      limits: {
        maxDepth: 4,
        maxCalls: 8,
        maxCapabilityExecutions: 8,
        maxObjectiveChars: ROLE_CALL_OBJECTIVE_MAX_LENGTH,
        maxResultChars: ROLE_CALL_RESULT_MAX_LENGTH,
        maxResponseChars: ROLE_CALL_RESPONSE_MAX_LENGTH,
      },
    },
  });
}

function createDependencyArtifactProvider(
  agentWorkDir: string,
  author: WorkerCapabilityPayloadAuthor["author"],
) {
  const registration = dependencyArtifactRegistration();
  const execute: ToolRegistry["execute"] = async () => executed();
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition],
    listNormalInvocations: () => [registration],
    getDefinition: (name) =>
      name === registration.definition.name
        ? registration.definition
        : undefined,
    hasToolsAvailable: () => true,
    getImplementations: () => ({}),
    prepareSharedState: (state = {}) => ({
      ...state,
      runtimePaths: Object.freeze({ agentWorkDir }),
    }),
    execute,
  };
  return createRegisteredToolWorkerCapabilityProvider<
    Readonly<Record<string, never>>
  >({
    getRequestToolRegistry: () => registry,
    requestId: "planner-worker-artifact-context",
    sessionId: "planner-worker-artifact-context-session",
    abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access",
    payloadAuthor: { author },
    nextApprovalId: () => "approval-unused",
  });
}

function dependencyArtifactRegistration(): RegisteredToolNormalInvocation {
  const operation: ToolNormalInvocationOperation = {
    operationId: "write_complete_file",
    summary: "Write one complete file.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4_096 },
      },
      required: ["path"],
    },
    payload: {
      kind: "raw_text",
      param: "content",
      instructions: "Return the complete file body.",
      maxBytes: 4_096,
    },
    effect: "mutating",
    approval: "request_policy",
  };
  return {
    toolName: "complete_file_writer",
    definition: {
      name: "complete_file_writer",
      routingCapability: "filesystem_mutation",
      executionEffect: "mutating",
      params: { path: "string", content: "string" },
      payloadChannelSpec: {
        params: ["content"],
        outputParam: "content",
        generationMode: "raw_text",
        targetParam: "path",
        targetRole: "payload_body",
        contextScope: "target_with_artifacts",
      },
    },
    contract: { version: 1, operations: [operation] },
  };
}

function executed(): ToolExecutionResult {
  return {
    ok: true,
    tool: "complete_file_writer",
    output: "Created the stylesheet.",
    producedNewInformation: true,
    data: { mutationEvidence: true },
  };
}

async function settleArtifactCapability(
  ledger: RoleCallLedger,
  callId: string,
  target: string,
  summary: string,
): Promise<void> {
  const running = await commit(ledger, {
    authority: "active_role",
    type: "begin_capability_execution",
    callId,
    invocationAttempt: 1,
    capabilityId: "write_complete_file",
    declaredEffect: "mutation",
    intent: summary,
    controlsJson: JSON.stringify({ path: target }),
  });
  const execution = running.state.capabilityExecutions.find(
    (candidate) =>
      candidate.callId === callId && candidate.status === "running",
  );
  if (!execution) throw new Error("Running artifact execution missing");
  await commit(ledger, {
    authority: "runtime",
    type: "settle_capability_execution",
    callId,
    executionId: execution.executionId,
    outcome: "succeeded",
    observedEffect: "mutation",
    summary,
    references: [{ kind: "tool_target", target }],
    exactResult: {
      kind: "generic_capability_result_v1",
      authority: "capability_adapter",
      status: "executed",
      ok: true,
      payload: { target },
    },
  });
}

async function returnChild(
  ledger: RoleCallLedger,
  callerCallId: string,
  childCallId: string,
  summary: string,
): Promise<void> {
  await commit(ledger, {
    authority: "runtime",
    type: "return_child",
    callerCallId,
    childCallId,
    outcome: "completed",
    summary,
  });
}

async function commit(
  ledger: RoleCallLedger,
  command: unknown,
): Promise<RoleCallLedgerHead> {
  const result = await ledger.apply({
    expectedHead: ledger.current(),
    command,
  });
  if (!result.ok) throw new Error(result.code);
  return result.head;
}
