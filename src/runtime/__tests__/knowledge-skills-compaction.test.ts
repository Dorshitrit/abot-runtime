import { afterEach, beforeEach, expect, test } from "vitest";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { captureRoleCallLedgerCheckpoint } from "../orchestration/role-calls/checkpoint.js";
import { restoreApprovalCompaction } from "../request/approval-wait/super-compaction-restore.js";
import { requireLiveSuperContextScope } from "../request/super-context-scope.js";
import { captureRequestContextCompaction, restoreRequestContextCompaction } from "../context/semantic-compaction/snapshot.js";
import { createSemanticCompactionSha256Fingerprint } from "../context/semantic-compaction/contracts.js";
import {
  assertSuperCompactionCheckpointIntegrity,
  assertSuperCompactionSourceIntegrity,
} from "../context/semantic-compaction/super-source-integrity.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";
import {
  activeSkillCall,
  createKnowledgeSkillsCompactionFixture,
  SKILL_COMPACTION_ANSWER,
  SKILL_COMPACTION_CONTENT,
  SKILL_COMPACTION_FACT,
  SKILL_COMPACTION_PADDING,
  UNREQUESTED_SKILL_CONTENT,
} from "./support/knowledge-skills-compaction-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

const SUPER_COMPACTION_STEPS = [
  "super.compact.coverage", "super.compact.content", "super.compact.merge", "super.compact.continuation",
];
const isCompactionStep = (step: string) => step === "context.compact" || SUPER_COMPACTION_STEPS.includes(step);

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s carries its Skill-read path through presentation, semantic compaction and serialized source restore",
  async (policy) => {
    const fixture = await createKnowledgeSkillsCompactionFixture(policy);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.ledger.current().state.capabilityExecutions).toEqual([]);
    await fixture.readSkill();
    const expectedToolCalls = policy === "execution-agent-v1" ? 1 : 0;
    if (policy === "execution-agent-v1") {
      const execution = fixture.ledger.current().state.capabilityExecutions[0]!;
      expect(execution).toMatchObject({
        capabilityId: "read_skill", status: "settled", outcome: "succeeded", observedEffect: "observation",
        exactResult: {
          kind: "registered_tool_execution_result_v1", authority: "registered_plugin",
          result: { tool: "abot_skills", ok: true, output: JSON.stringify({
            skillId: "abot-studio", name: "ABot Studio", content: SKILL_COMPACTION_CONTENT,
          }) },
        },
      });
      expect(fixture.execute.mock.calls[0]![0]).toMatchObject({
        tool: "abot_skills", params: { action: "read_skill", skillId: "abot-studio" },
      });
    } else {
      expect(fixture.ledger.current().state.capabilityExecutions).toEqual([]);
      expect(fixture.ledger.current().state.skillReads).toEqual([{
        readId: "skill-read-1", callId: "call-1", invocationAttempt: 1, steeringVersion: 0,
        operation: "read_skills", selectors: ["abot-studio"],
        result: { outcome: "completed", skills: [{
          skillId: "abot-studio", name: "ABot Studio", description: "A procedural reference.",
          content: SKILL_COMPACTION_CONTENT,
        }] },
      }]);
    }
    expect(fixture.execute).toHaveBeenCalledTimes(expectedToolCalls);

    await fixture.runDecision();
    if (policy === "execution-agent-v1")
      await expect(fixture.runRootResponse()).resolves.toBe(SKILL_COMPACTION_ANSWER);
    const presentationStep = policy === "execution-agent-v1" ? "execution.response" : "worker.result";
    const originalPresentation = fixture.modelInputs.find(({ step }) => step === presentationStep)!;
    expect(originalPresentation).toBeDefined();
    expect(JSON.stringify(originalPresentation.messages)).toContain(SKILL_COMPACTION_PADDING);
    expect(JSON.stringify(originalPresentation.messages)).not.toContain(UNREQUESTED_SKILL_CONTENT);
    expect(() => validateModelGatewayMessages(originalPresentation.messages)).not.toThrow();
    expect(fixture.request.contextCompactionStore!.snapshot!().checkpoints).toEqual([]);

    const startCompaction = fixture.modelInputs.length;
    fixture.forceCompaction();
    await fixture.runDecision();
    const compactedCalls = fixture.modelInputs.slice(startCompaction);
    const expectedCompactionSteps = policy === "execution-agent-v1" ? ["context.compact"]
      : SUPER_COMPACTION_STEPS.filter((step) => step !== "super.compact.merge");
    expect(new Set(compactedCalls.filter(({ step }) => isCompactionStep(step)).map(({ step }) => step)))
      .toEqual(new Set(expectedCompactionSteps));
    expect(fixture.measuredInputs.some(({ inputTokens }) => inputTokens === 63_500)).toBe(true);
    for (const { messages } of compactedCalls.filter(({ step }) => !isCompactionStep(step))) {
      expect(() => validateModelGatewayMessages(messages)).not.toThrow();
      expect(JSON.stringify(messages)).toContain(SKILL_COMPACTION_FACT);
      expect(JSON.stringify(messages)).not.toContain(SKILL_COMPACTION_PADDING);
      expect(JSON.stringify(messages)).not.toContain(UNREQUESTED_SKILL_CONTENT);
    }

    const snapshot = captureRequestContextCompaction(fixture.request.contextCompactionStore!);
    expect(snapshot.checkpoints).toHaveLength(1);
    const sourceKind = policy === "execution-agent-v1"
      ? "registered_tool_execution_result_v1" : "runtime_core_skill_read_v1";
    expect(snapshot.sources.some(({ content }) => content.includes(sourceKind))).toBe(true);
    expect(JSON.stringify(snapshot.sources)).toContain(SKILL_COMPACTION_PADDING);
    const snapshotBytes = JSON.stringify(snapshot);
    const restored = restoreRequestContextCompaction(JSON.parse(snapshotBytes));
    const restoredRequest = deriveTestRequestExecutionScope(fixture.request, { contextCompactionStore: restored });
    expect(restored.snapshot!()).toEqual(snapshot);

    if (policy === "supervisor-worker-v1") {
      expect(snapshot.sources.map(({ sourceRef }) => sourceRef))
        .toEqual(["core-skill-read:skill-read-1:abot-studio"]);
      const integrity = {
        requestId: restoredRequest.requestId, prompt: restoredRequest.prompt,
        head: fixture.ledger.current(), store: restored,
      };
      expect(() => assertSuperCompactionSourceIntegrity(integrity)).not.toThrow();
      expect(() => assertSuperCompactionCheckpointIntegrity({ ...integrity, checkpoint: snapshot.checkpoints[0]! })).not.toThrow();
      expect(() => requireLiveSuperContextScope({
        request: restoredRequest, head: fixture.ledger.current(), call: activeSkillCall(fixture.ledger),
        contractId: "delegated.worker",
      })).not.toThrow();
    }

    const afterRestore = fixture.modelInputs.length;
    await fixture.runDecision(restoredRequest);
    if (policy === "execution-agent-v1")
      await expect(fixture.runRootResponse(restoredRequest)).resolves.toBe(SKILL_COMPACTION_ANSWER);
    const resumedCalls = fixture.modelInputs.slice(afterRestore);
    expect(resumedCalls.some(({ step }) => isCompactionStep(step))).toBe(false);
    const resumedPresentation = resumedCalls.find(({ step }) => step === presentationStep)!;
    expect(resumedPresentation).toBeDefined();
    expect(JSON.stringify(resumedPresentation.messages)).toContain(SKILL_COMPACTION_FACT);
    expect(JSON.stringify(resumedPresentation.messages)).not.toContain(SKILL_COMPACTION_PADDING);
    expect(fixture.execute).toHaveBeenCalledTimes(expectedToolCalls);
    expect(JSON.stringify(restored.snapshot!())).toBe(snapshotBytes);
  },
);

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s accepts compacted Skill sources at the parked approval boundary before any continuation",
  async (policy) => {
    const fixture = await createKnowledgeSkillsCompactionFixture(policy);
    const expectedToolCalls = policy === "execution-agent-v1" ? 1 : 0;
    await fixture.readSkill();
    fixture.forceCompaction();
    await fixture.runDecision();
    const original = captureRequestContextCompaction(fixture.request.contextCompactionStore!);
    await fixture.parkForApproval();
    const ledgerCheckpoint = JSON.parse(JSON.stringify(captureRoleCallLedgerCheckpoint(fixture.ledger)));
    const restoreInput = {
      ledgerCheckpoint,
      requestId: fixture.request.requestId, prompt: fixture.request.prompt,
      executionPolicy: fixture.request.executionPolicy,
    };
    const modelCallsBeforeRestore = fixture.modelInputs.length;
    const restored = restoreApprovalCompaction({ ...restoreInput, snapshot: JSON.parse(JSON.stringify(original)) });
    expect(restored.snapshot!()).toEqual(original);
    expect(fixture.modelInputs).toHaveLength(modelCallsBeforeRestore);
    expect(fixture.execute).toHaveBeenCalledTimes(expectedToolCalls);
    if (policy !== "supervisor-worker-v1") return;

    const source = original.sources[0]!;
    const content = source.content.replace(SKILL_COMPACTION_PADDING, "altered-reference-content");
    const sourceFingerprint = createSemanticCompactionSha256Fingerprint(content);
    const changed = {
      ...original,
      sources: [{ ...source, content, sourceFingerprint }],
      checkpoints: original.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        sourceDigests: checkpoint.sourceDigests.map((digest) => ({ ...digest, sourceFingerprint })),
      })),
    };
    expect(() => restoreApprovalCompaction({
      ...restoreInput, snapshot: changed,
    })).toThrow("context_compaction_snapshot_source_incompatible");
    expect(fixture.modelInputs).toHaveLength(modelCallsBeforeRestore);
    expect(fixture.execute).toHaveBeenCalledTimes(expectedToolCalls);
    expect(fixture.request.contextCompactionStore!.snapshot!()).toEqual(original);
  },
);
