import { expect, vi } from "vitest";
import type { ModelGatewayClient } from "../../ports.js";
import { readHandoffCapsule } from "./system-target-handoff-script.js";

export const MEDIA_FINAL = "The two-pixel fixture was observed.";
export type MediaPolicy = "execution-agent-v1" | "supervisor-worker-v1";

export function createMediaRequestScript(policy: MediaPolicy) {
  const turns = new Map<string, number>();
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
    const step = input.modelStep!;
    const turn = (turns.get(step) ?? 0) + 1;
    turns.set(step, turn);
    const reply = (decision: unknown) => ({ text: JSON.stringify({ decision }), meta: {} });
    if (step === "capability.controls") return reply(policy === "execution-agent-v1"
      ? { invocations: { invocation_1: { disposition: "execute", controls: {} } } }
      : { action: "invoke_capability", controls: {} });
    if (step === "execution.decision") {
      if (turn === 1) return reply({ action: "open_capability_scope", catalogGroupIds: ["fixture"], acknowledgement: "I will inspect the fixture." });
      if (turn === 2) return reply({ action: "invoke_capability", capabilityId: "capture_fixture", intent: "Observe the fixture.", workingDirectory: "." });
      expect(turn).toBe(3);
      return reply({ action: "respond" });
    }
    if (step === "supervisor.decision") {
      if (turn === 1) return reply({ action: "invoke_role", roleId: "planner", objective: "Inspect the fixture.", acknowledgement: "I will inspect the fixture." });
      if (turn === 2) return { text: JSON.stringify({ workingDirectory: "." }), meta: {} };
      if (turn === 3) return reply({ action: "invoke_role", roleId: "reviewer" });
      expect(turn).toBe(4);
      return reply({ action: "respond" });
    }
    if (step === "planner.decision") {
      if (turn === 1) return reply({ action: "invoke_role", roleId: "worker", plan: { summary: "Inspect the fixture.", items: [{ title: "Inspect fixture", objective: "Inspect the fixture." }] }, selectedItemIndexes: [0], workerCapabilityScope: { catalogGroupIds: ["fixture"] } });
      expect(turn).toBe(2);
      expect(JSON.stringify(input.messages)).toContain(MEDIA_FINAL);
      return reply({ action: "return_result", result: MEDIA_FINAL });
    }
    if (step === "worker.decision") {
      if (turn === 1) return reply({ action: "invoke_capability", capabilityId: "capture_fixture", intent: "Observe the fixture." });
      expect(turn).toBe(2);
      return reply({ action: "return_result" });
    }
    if (step === "reviewer.decision") {
      const audit = readHandoffCapsule(input, "runtime_reviewer_audit_v4");
      expect(audit.effects).toHaveLength(1);
      return reply({ action: "report_gaps", reviewScopeId: audit.auditScope.reviewScopeId, summary: "Only the producing Worker received the original pixels.", audit: {
        evidenceAssessments: audit.effects.map((effect: { evidenceRef: string }) => ({ evidenceRef: effect.evidenceRef, status: "supports", finding: "A bounded tool observation succeeded." })),
        completionAssessment: { status: "gap", evidenceRefs: audit.effects.map((effect: { evidenceRef: string }) => effect.evidenceRef), finding: "Original pixels were not delegated to this review." },
      }, gaps: [{ kind: "missing_evidence", subjectRefs: [], factRefs: [], evidenceRefs: [], summary: "Original pixels remain scoped to Worker." }] });
    }
    if (["worker.result", "execution.response", "supervisor.response"].includes(step))
      return { text: MEDIA_FINAL, meta: {} };
    throw new Error(`Unexpected media fixture model step: ${step}`);
  });
  return { invoke, invokeRaw: vi.fn(async () => { throw new Error("No live/raw provider in media fixture"); }) };
}
