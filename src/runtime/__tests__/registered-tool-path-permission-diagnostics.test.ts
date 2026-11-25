import * as fs from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import type { ToolRegistry } from "../ports.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import { createRoleCallLedger } from "../orchestration/role-calls/index.js";
import { createWorkerCapabilityBinding, type WorkerCapabilityPayloadAuthor } from "../orchestration/worker-capabilities/index.js";
import { projectRequestToolResults } from "../context/request-tool-results.js";
import { buildWorkerDecisionInput } from "../steps/worker-decision/input.js";
import { buildExecutionCapabilityResultMessage } from "../steps/execution-agent/capability-result-context.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { runtimePathRejectionFixture } from "./support/runtime-path-rejection-fixture.js";
import { createWorkerDecisionModelPolicy, createWorkerDecisionRunnerConfig } from "./support/worker-decision-model-fixture.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync), lstatSync: vi.fn(actual.lstatSync) };
});

let root: string;
let actualFs: typeof fs;
beforeEach(async () => {
  configureDebugLogger({ enabled: false });
  actualFs = await vi.importActual<typeof fs>("node:fs");
  vi.mocked(fs.realpathSync).mockImplementation(actualFs.realpathSync);
  vi.mocked(fs.lstatSync).mockImplementation(actualFs.lstatSync);
  root = await realpath(await mkdtemp(join(tmpdir(), "path-permission-diagnostic-")));
  await mkdir(join(root, "Project"));
  await writeFile(join(root, "target.txt"), "Exact existing content.");
});
afterEach(async () => {
  vi.mocked(fs.realpathSync).mockImplementation(actualFs.realpathSync);
  vi.mocked(fs.lstatSync).mockImplementation(actualFs.lstatSync);
  await rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
  resetDebugLoggerConfig();
});

function failCanonicalization(target: string, code: "EACCES" | "EPERM" | "EIO") {
  const failure = () => Object.assign(new Error(`PRIVATE_FS_DETAIL:${target}`), { code });
  vi.mocked(fs.realpathSync).mockImplementation((...args) => {
    if (String(args[0]) === target) throw failure();
    return Reflect.apply(actualFs.realpathSync, undefined, args);
  });
  vi.mocked(fs.lstatSync).mockImplementation((...args) => {
    if (String(args[0]) === target) throw failure();
    return Reflect.apply(actualFs.lstatSync, undefined, args);
  });
}

test.each(["EACCES", "EPERM", "EIO"] as const)(
  "%s during workingDirectory '.' scoping reaches EA with the owned reason before payload or approval",
  async (errno) => {
    const f = await runtimePathRejectionFixture({ root, role: "root" });
    expect(f.call.workingDirectory).toBe(".");
    failCanonicalization(root, errno);
    await f.run("Project/target.txt");
    const head = f.ledger.current();
    const receipt = head.state.capabilityExecutions[0]!;
    const summary = errno === "EIO"
      ? "The target path could not be resolved safely. No external execution occurred."
      : "The target path could not be resolved because filesystem access was denied. No external execution occurred.";
    expect(receipt).toMatchObject({ outcome: "failed", observedEffect: "none", summary,
      exactResult: { kind: "runtime_capability_rejection_v1", authority: "runtime",
        stage: "before_external_execution", code: "runtime_tool_path_canonicalization_failed", message: summary } });
    const capsule = JSON.parse(buildExecutionCapabilityResultMessage(head, receipt, "model").content);
    expect(capsule.result).toMatchObject({ summary, observedEffect: "none", adapterResult: receipt.exactResult });
    expect(JSON.stringify(capsule)).not.toContain(root);
    expect(JSON.stringify(capsule)).not.toContain("PRIVATE_FS_DETAIL");
    expect(f.onEvent.mock.calls.map(([name]) => name)).toEqual(["tool.failed"]);
    expect(f.author).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.requestToolApproval).not.toHaveBeenCalled();
    expect(f.nextApprovalId).not.toHaveBeenCalled();
  },
);

const registration: RegisteredToolNormalInvocation = {
  toolName: "selected_target_editor",
  definition: {
    name: "selected_target_editor", routingCapability: "filesystem_mutation", executionEffect: "mutating",
    params: { path: "string", content: "string" },
    payloadChannelSpec: { params: ["content"], outputParam: "content", generationMode: "raw_text",
      targetParam: "path", targetContext: "full_numbered", stages: [{ outputParam: "content" }] },
  },
  contract: { version: 1, operations: [{ operationId: "revise_selected_target", summary: "Revise the selected file.",
    effect: "mutating", approval: "always",
    input: { type: "object", additionalProperties: false,
      properties: { path: { type: "string", minLength: 1, maxLength: 256 } }, required: ["path"] },
    payload: { kind: "raw_text", param: "content", instructions: "Return the revised file.", minBytes: 1, maxBytes: 4096 },
  }] },
};

async function lateReadFixture() {
  const requestId = "target-permission-diagnostic";
  const objective = "Revise the selected existing file.";
  const author = vi.fn<WorkerCapabilityPayloadAuthor["author"]>();
  const execute = vi.fn<ToolRegistry["execute"]>();
  const requestToolApproval = vi.fn(async () => ({ approved: true }));
  const nextApprovalId = vi.fn(() => "unexpected-approval");
  const onEvent = vi.fn();
  const registry: ToolRegistry = {
    listDefinitions: () => [registration.definition], listNormalInvocations: () => [registration],
    getDefinition: () => registration.definition, hasToolsAvailable: () => true,
    getImplementations: () => ({}), execute,
    prepareSharedState: (state) => ({ ...state, runtimePaths: { agentWorkDir: root } }),
  };
  const provider = createRegisteredToolWorkerCapabilityProvider({ getRequestToolRegistry: () => registry,
    requestId, sessionId: "target-permission-session", abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access", toolApprovalController: { requestToolApproval },
    nextApprovalId, payloadAuthor: { author }, onEvent });
  const ledger = createRoleCallLedger({ requestId, policy: { limits: { maxDepth: 4, maxCalls: 8,
    maxCapabilityExecutions: 8, maxObjectiveChars: 8192, maxResultChars: 8192, maxResponseChars: 65536 } } });
  for (const command of [{ authority: "runtime", type: "create_root" },
    { authority: "active_role", type: "open_child", callerCallId: "call-1", roleId: "worker", objective }]) {
    const result = await ledger.apply({ expectedHead: ledger.current(), command });
    if (!result.ok) throw new Error(result.code);
  }
  const call = ledger.current().state.calls.at(-1)!;
  const binding = createWorkerCapabilityBinding({ requestId, ledger, call, context: {}, adapters: provider.getAdapters() });
  return { requestId, objective, author, execute, requestToolApproval, nextApprovalId, onEvent, provider, ledger, call, binding };
}

test.each(["EACCES", "EPERM", "EIO"] as const)(
  "%s during selected payload target resolution reaches the next Worker decision without authoring or execution",
  async (errno) => {
    const f = await lateReadFixture();
    expect(f.call.workingDirectory).toBeUndefined();
    failCanonicalization(join(root, "target.txt"), errno);
    await f.binding.execute({ capabilityId: "revise_selected_target", intent: f.objective,
      authoringObjective: f.objective, controls: { path: "target.txt" } });
    const head = f.ledger.current();
    const receipt = head.state.capabilityExecutions[0]!;
    const code = errno === "EIO" ? "payload_target_context_read_failure" : "payload_target_context_access_denied";
    expect(receipt).toMatchObject({ outcome: "failed", observedEffect: "none", exactResult: {
      kind: "runtime_capability_rejection_v1", stage: "before_external_execution", code,
    } });
    expect(receipt.summary).toContain('"target.txt"');
    expect(receipt.summary).toContain(errno === "EIO" ? "could not be read" : "Access to the selected payload target was denied");
    if (errno === "EIO") expect(receipt.summary).not.toContain("denied");
    const call = head.state.calls.find(({ callId }) => callId === f.call.callId)!;
    const binding = createWorkerCapabilityBinding({ requestId: f.requestId, ledger: f.ledger, call,
      context: {}, adapters: f.provider.getAdapters() });
    const input = buildWorkerDecisionInput({ requestId: f.requestId, prompt: f.objective, historyMessages: [],
      agentMode: "reasoning", runnerConfig: createWorkerDecisionRunnerConfig(), modelPolicy: createWorkerDecisionModelPolicy(32_000) }, {
      call, requestToolResults: projectRequestToolResults({ ledger: f.ledger, head, callId: call.callId, modelStep: "worker.decision" }),
      capabilitySource: { ledger: f.ledger, head, binding },
      capabilityResume: { ledger: f.ledger, head, executionId: receipt.executionId },
    });
    const visible = input.context.messages.flatMap(({ content }) => {
      try { return [JSON.parse(content)]; } catch { return []; }
    }).find((capsule) => capsule.kind === "runtime_request_tool_results_v1");
    expect(visible.results[0].adapterResult).toEqual(receipt.exactResult);
    expect(JSON.stringify(visible)).not.toContain(root);
    expect(JSON.stringify(visible)).not.toContain("PRIVATE_FS_DETAIL");
    expect(f.onEvent).toHaveBeenCalledWith("tool.payload.failed", expect.objectContaining({ error: code }));
    expect(f.author).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.requestToolApproval).not.toHaveBeenCalled();
    expect(f.nextApprovalId).not.toHaveBeenCalled();
  },
);
