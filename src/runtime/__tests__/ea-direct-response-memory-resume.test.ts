import { afterEach, expect, test, vi } from "vitest";
import { supervisorFormatName } from "./support/supervisor-model-phases.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { successResult } from "../../plugin-sdk/index.js";
import type { SessionRecord } from "../../sessions/types.js";
import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import * as candidateProcessing from "../long-term-memory/candidate-processing.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { createExecApprovalScript } from "./support/exec-sensitive-approval-script.js";
import { makeOwnerControlPeer } from "./support/local-runtime-owner-peer.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetDebugLoggerConfig();
});

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)("saved %s approval restores initial memory after owner restart and queues candidates once", async policy => {
  const network = vi.fn(async () => { throw new Error("network_not_allowed"); });
  vi.stubGlobal("fetch", network);
  const base = await createSchedulerRuntimeFixture(policy);
  await base.application.stop();
  cleanup.push(() => base.dispose());

  const repository = createInMemoryLongTermMemoryRepository();
  await repository.update(() => ({
    records: [{
      id: "existing-style", content: "The user prefers detailed explanations.", tags: ["style"],
      provenance: { kind: "passive_response", sourceRequestId: "prior", sourceSessionId: "prior" },
      automaticManagement: "allowed", createdAt: "2026-10-12T10:00:00.000Z",
      updatedAt: "2026-10-12T10:00:00.000Z",
    }],
    vectors: [{ memoryId: "existing-style", modelFingerprint: "approval-memory-fixture",
      dimensions: 2, vector: [1, 0] }],
  }));
  const processor = vi.spyOn(candidateProcessing, "processMemoryCandidates");
  const realMemory = createLongTermMemoryService({
    repository, enabled: true, emitClientEvents: false,
    embeddings: { embed: vi.fn(async ({ texts }) => ({
      modelFingerprint: "approval-memory-fixture", dimensions: 2,
      vectors: texts.map(() => [1, 0]),
    })) },
  });
  const memoryMessage: ChatMessage = {
    role: "system", content: "Custom stored preference with an attachment.",
    attachments: [{ id: "memory-image", kind: "image", mimeType: "image/png",
      storageRef: "memory/preference.png", name: "preference.png", size: 3, data: "YWJj" }],
  };
  const retrieve = vi.fn<LongTermMemoryService["retrieve"]>(async params => ({
    ...await realMemory.retrieve(params), message: { ...memoryMessage, attachments: [
      ...memoryMessage.attachments!,
      { id: "temporary-tool-image", kind: "image", mimeType: "image/png",
        storageRef: "request-tool-media", data: "PRIVATE_TOOL_PIXELS",
        toolEvidence: { executionId: "old-execution" } },
    ] },
  }));
  const prepare = vi.fn(async (...args: Parameters<NonNullable<LongTermMemoryService["learning"]>["prepare"]>) => {
    const knowledge = await realMemory.learning!.prepare(...args);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    return { ...knowledge, extraDate: new Date(), extraCallback: () => {}, extraCycle: cycle,
      entries: knowledge.entries.map(entry => ({
      ...entry, extraInstruction: "untrusted-checkpoint-field",
      extraDate: new Date(), extraCallback: () => {}, extraCycle: cycle,
    })) };
  });
  const scheduleCandidates = vi.fn(realMemory.scheduleCandidates);
  const memory: LongTermMemoryService = {
    ...realMemory, retrieve, scheduleCandidates, learning: { ...realMemory.learning!, prepare },
  };
  const startupTargetPreparations = policy === "execution-agent-v1" ? 1 : 0;
  const requestId = "saved-memory-request";
  const answer = "The requested action completed. I will keep this answer concise.";
  const content = "The user prefers concise explanations.";
  const script = createExecApprovalScript(
    policy,
    [{ capabilityId: "record_approval_effect", controls: {} }],
    "approval_fixture",
  );
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    expect(scheduleCandidates).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();
    const isPreparation = ["supervisor_presentation", "supervisor_skill_selection"]
      .includes(supervisorFormatName(input) ?? "");
    const rootStep = input.modelStep === "execution.decision" || input.modelStep === "execution.response"
      || (input.modelStep === "supervisor.decision" && !isPreparation) || input.modelStep === "supervisor.response";
    if (rootStep) {
      expect(retrieve).toHaveBeenCalledOnce();
      const messages = input.messages as readonly ChatMessage[];
      expect(messages.filter(message => message.content === memoryMessage.content)).toEqual([memoryMessage]);
      expect(JSON.stringify(messages)).not.toContain("untrusted-checkpoint-field");
    } else expect(JSON.stringify(input.messages)).not.toContain(memoryMessage.content);
    if (input.modelStep === "supervisor.response" && !input.format)
      return { text: answer, meta: {} };
    if (input.modelStep === "execution.response" || input.modelStep === "supervisor.response")
      return { text: JSON.stringify({
        ...(input.modelStep === "execution.response" ? { finalResponse: answer } : {}),
        memoryCandidates: [{
          content, tags: ["style"], target: "k1", score: 90,
          reason: "The current user directly states this preference.",
          reinforced: true, explicitRequestQuote: null,
        }],
      }), meta: {} };
    return script.invoke(input);
  });
  const execute = vi.fn(async () =>
    successResult({ output: "The approved fixture action completed." }),
  );
  const module: ToolModuleDeclaration = {
    definition: {
      name: "approval_fixture_effect",
      routingCapability: "semantic_mutation",
      catalogGroups: ["approval_fixture"],
    },
    normalInvocation: {
      version: 1,
      operations: [{
        operationId: "record_approval_effect", summary: "Record an effect.",
        effect: "mutating", approval: "request_policy",
        input: {
          type: "object", additionalProperties: false,
          properties: {}, required: [],
        },
      }],
    },
    implementation: execute,
  };
  const startOwner = async () => {
    const owner = await createLocalRuntimeOwner(base.config, {
      models: { invoke, invokeRaw: script.invokeRaw },
      tools: createConfiguredToolRegistry(base.config, [module]),
      longTermMemory: memory,
    });
    cleanup.push(async () => {
      await owner.stop();
      await owner.whenIdle?.();
    });
    return owner;
  };
  let owner = await startOwner();
  const { peer } = makeOwnerControlPeer("memory-resume-view");
  const readSession = async () => await owner.call(
    "sessions.getSessionById", ["session"], peer,
  ) as SessionRecord;
  const parked = await owner.call("request.run", [{
    type: "run_request", requestId, sessionId: "session",
    text: "I prefer concise explanations. Perform the fixture action.",
    toolPermissionMode: "ask", agentMode: "reasoning",
    modelPreference: { profileId: "scheduled-model", scope: "all" },
  }, { durableApprovals: true, approvalAvailable: true }], peer);

  expect(parked).toMatchObject({ kind: "awaiting_approval" });
  const continuationDir = join(base.config.paths.sessionsDir, ".request-continuations", "session");
  const blobs = await readdir(continuationDir);
  expect(blobs.length).toBeGreaterThan(0);
  for (const blob of blobs) {
    const saved = await readFile(join(continuationDir, blob), "utf8");
    expect(saved).not.toMatch(/PRIVATE_TOOL_PIXELS|temporary-tool-image|toolEvidence|extraDate|extraCallback|extraCycle|untrusted-checkpoint-field/);
    expect(saved).toContain("memory-image");
  }
  expect(owner.isIdle?.()).toBe(true);
  expect(execute).not.toHaveBeenCalled();
  expect(retrieve).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledTimes(startupTargetPreparations);
  expect(scheduleCandidates).not.toHaveBeenCalled();
  expect(processor).not.toHaveBeenCalled();
  expect((await repository.read()).learningCandidates ?? []).toEqual([]);
  expect((await readSession()).requests!.find(
    (request) => request.requestId === requestId,
  )!.status).toBe("awaiting_approval");
  const [pending] = await owner.call(
    "request.approvals", ["session"], peer,
  ) as LocalPendingToolApproval[];
  expect(pending).toMatchObject({ request: { requestId }, sessionId: "session" });
  const command = {
    sessionId: "session", requestId, approvalId: pending!.request.approvalId,
    ...pending!.wait!, commandId: "approve-memory-once", approved: true,
  };

  const beforeRestart = invoke.mock.calls.length;
  await owner.stop();
  await owner.whenIdle?.();
  owner = await startOwner();
  expect(await owner.call("request.approvals", ["session"], peer)).toEqual([pending]);
  expect(invoke).toHaveBeenCalledTimes(beforeRestart);
  expect(retrieve).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledTimes(startupTargetPreparations);

  expect(await owner.call("request.approval.decide", [command], peer))
    .toEqual({ accepted: true });
  await owner.whenIdle?.();
  await vi.waitFor(() => expect(processor).toHaveBeenCalledOnce());
  await processor.mock.results[0]!.value;

  expect(execute).toHaveBeenCalledOnce();
  expect(retrieve).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledOnce();
  expect(scheduleCandidates).toHaveBeenCalledOnce();
  expect(scheduleCandidates.mock.calls[0]![0]).toMatchObject({
    context: { requestId, sessionId: "session" },
    candidates: [expect.objectContaining({ content })],
  });
  const session = await readSession();
  expect(session.requests!.find((request) => request.requestId === requestId)!.status)
    .toBe("completed");
  expect(session.messages.filter(
    (message) => message.requestId === requestId && message.kind === "terminal",
  )).toEqual([expect.objectContaining({ role: "assistant", content: answer })]);
  const saved = await repository.read();
  expect(saved.learningCandidates).toHaveLength(1);
  expect(saved.learningCandidates![0]).toMatchObject({
    content,
    sources: [expect.objectContaining({
      sourceRequestId: requestId, sourceSessionId: "session",
    })],
  });
  expect(saved.learningReceipts).toHaveLength(1);

  expect(await owner.call("request.approval.decide", [command], peer))
    .toEqual({ accepted: true, duplicate: true });
  await owner.whenIdle?.();
  expect(scheduleCandidates).toHaveBeenCalledOnce();
  expect(processor).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
  expect(script.invokeRaw).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
}, 20_000);
