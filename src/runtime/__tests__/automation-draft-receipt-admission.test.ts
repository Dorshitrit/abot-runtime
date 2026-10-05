import { describe, expect, it, vi } from "vitest";
import { executeToolCall } from "../../capabilities/tool-executor.js";
import { createAutomationDraftManager, type AutomationDraftPlanAcceptance } from "../automations/draft-management.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import type { AutomationService } from "../automations/service.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import { createAutomationBuilderToolModule } from "../capabilities/automation-builder/tool-module.js";
import { automationBuilderToolContract } from "../capabilities/automation-builder/tool-contract.js";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";
import { AutomationDraftReceiptCapacityError, prepareAutomationDraftReceipt } from "../capabilities/automations/draft-receipt-admission.js";
import { CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES, normalizeCapabilityAdapterResult } from "../orchestration/capability-adapters/result.js";
import { attachTargetReferences, captureRegisteredToolResult, projectToolTargetReferences } from "../adapters/registered-tool-worker-capabilities/result-evidence.js";

function fixture() {
  let state = emptyAutomationJournalState();
  let commits = 0;
  const persistence: AutomationPersistence = {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const next = structuredClone(state);
      const result = mutate(next);
      state = next;
      commits += 1;
      return result;
    },
    updateWithScheduler: async () => { throw new Error("unexpected_scheduler_mutation"); },
  };
  const drafts = createAutomationDraftManager({ persistence });
  const service = { createDraftPlan: drafts.createPlan, applyDraftPlan: drafts.applyPlan,
    getDraft: drafts.get } as unknown as AutomationService;
  const builder = createAutomationBuilderToolModule(() => service, async () => undefined);
  const reader = createAutomationDraftToolModule(() => service, async () => undefined);
  const write = async (index: number, previous?: { automationId: string; revision: number; rootSequenceId: string }) => {
    const plan = unicodeToolsPlan(index, previous?.rootSequenceId);
    expect(Buffer.byteLength(JSON.stringify(plan))).toBeLessThan(32 * 1024);
    return builder.implementation({ planJson: JSON.stringify(plan), ...(previous
      ? { action: "apply_automation_draft_changes", automationId: previous.automationId, expectedRevision: previous.revision }
      : { action: "create_automation_draft", title: "QA" }) });
  };
  return { drafts, builder, reader, write, commits: () => commits };
}

function unicodeToolsPlan(index: number, rootSequenceId = "$root") {
  const tools = Array.from({ length: 64 }, (_, position) => ({ operation: {
    toolName: "界".repeat(60) + String(index * 64 + position).padStart(3, "0"),
    operationId: "語".repeat(64), contractVersion: 1,
  }, usage: "available" }));
  return { version: 1, commands: [{ as: `step${index}`, mutation: {
    kind: "add_node", parentSequenceId: rootSequenceId, index,
    nodeWithoutId: { kind: "agent", title: "QA", onFailure: "stop", modelProfileId: "offline",
      agentMode: "fast", roleInstructions: "", prompt: "QA", inputs: {}, tools, result: { kind: "text" } },
  } }] };
}

const metadataPlan = { version: 1, commands: [{ mutation: {
  kind: "update_definition", patch: { objective: "Accepted later edit" },
} }] };

function envelope(output: string, references: readonly { kind: "tool_target"; target: string }[] = []) {
  return { kind: "registered_tool_execution_result_v1", authority: "registered_plugin", status: "executed",
    result: { ok: true, output, producedNewInformation: true, tool: "automation_builder", progress: false,
      data: { mutationEvidence: true, currentStateEvidence: true } },
    ...(references.length ? { references } : {}),
  };
}

describe("automation draft receipt admission", () => {
  it("rejects an oversized Unicode receipt before committing and permits a valid follow-up at the same revision", async () => {
    const f = fixture();
    const first = await f.write(0);
    expect(first.ok).toBe(true);
    const second = await f.write(1, JSON.parse(first.output));
    expect(second.ok).toBe(true);
    const saved = JSON.parse(second.output);
    const before = await f.drafts.get(saved.automationId);
    const rejected = await f.write(2, saved);
    expect(rejected).toMatchObject({ ok: false, error: "automation_authoring_receipt_too_large",
      producedNewInformation: false, data: { mutationEvidence: false } });
    expect(JSON.parse(rejected.output)).toMatchObject({ code: "automation_authoring_receipt_too_large",
      maxResultBytes: CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES });
    expect(await f.drafts.get(saved.automationId)).toEqual(before);
    expect(f.commits()).toBe(2);
    const updated = await f.builder.implementation({ action: "apply_automation_draft_changes",
      automationId: saved.automationId, expectedRevision: 2, planJson: JSON.stringify(metadataPlan) });
    expect(updated.ok).toBe(true);
    expect(JSON.parse(updated.output)).toMatchObject({ revision: 3,
      draft: { definition: { objective: "Accepted later edit" } } });
    expect(f.commits()).toBe(3);
  });

  it("returns a bounded explicit read failure for an existing legal large draft without changing it", async () => {
    const f = fixture();
    const first = await f.drafts.createPlan("QA", unicodeToolsPlan(0));
    const id = first.draft.automationId;
    await f.drafts.applyPlan(id, 1, unicodeToolsPlan(1, first.draft.definition.body.id));
    const third = await f.drafts.applyPlan(id, 2, unicodeToolsPlan(2, first.draft.definition.body.id));
    expect(Buffer.byteLength(JSON.stringify(third.draft.definition))).toBeLessThan(128 * 1024);
    const result = await f.reader.implementation({ action: "read_draft", automationId: id });
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({ code: "automation_authoring_receipt_too_large",
      maxResultBytes: CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES, message: expect.any(String) });
    expect(normalizeCapabilityAdapterResult({ kind: "registered_tool_execution_result_v1",
      authority: "registered_plugin", status: "executed", result: { ...result, tool: "automations", progress: false } }).ok).toBe(true);
    expect(await f.drafts.get(id)).toEqual(third.draft);
    expect(f.commits()).toBe(3);
  });

  it("keeps creation and apply atomic when synchronous acceptance rejects the candidate", async () => {
    const f = fixture();
    const reject: AutomationDraftPlanAcceptance = vi.fn(() => { throw new Error("receipt_rejected"); });
    await expect(f.drafts.createPlan("QA", metadataPlan, reject)).rejects.toThrow("receipt_rejected");
    expect(await f.drafts.list()).toEqual([]);
    expect(f.commits()).toBe(0);
    const created = await f.drafts.createPlan("QA", metadataPlan);
    await expect(f.drafts.applyPlan(created.draft.automationId, 1, metadataPlan, reject)).rejects.toThrow("receipt_rejected");
    expect(await f.drafts.get(created.draft.automationId)).toEqual(created.draft);
    expect(f.commits()).toBe(1);
  });

  it.each([null, () => undefined, () => false, async () => true])(
    "requires an explicit synchronous acceptance and never commits an unsupported callback (%s)", async (unsupported) => {
      const f = fixture();
      const accept = unsupported as unknown as AutomationDraftPlanAcceptance;
      await expect(f.drafts.createPlan("QA", metadataPlan, accept)).rejects.toThrow("automation_draft_plan_acceptance_invalid");
      expect(await f.drafts.list()).toEqual([]);
      expect(f.commits()).toBe(0);
      const created = await f.drafts.createPlan("QA", metadataPlan);
      await expect(f.drafts.applyPlan(created.draft.automationId, 1, metadataPlan, accept))
        .rejects.toThrow("automation_draft_plan_acceptance_invalid");
      expect(await f.drafts.get(created.draft.automationId)).toEqual(created.draft);
      expect(f.commits()).toBe(1);
    },
  );

  it("counts the outer JSON escaping rather than the inner receipt string alone", () => {
    const receipt = { text: "\\".repeat(66_000) };
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES);
    expect(() => prepareAutomationDraftReceipt(receipt, { tool: "automation_builder",
      operation: automationBuilderToolContract.operations[0], params: { title: "QA" }, mutationEvidence: true }))
      .toThrow(AutomationDraftReceiptCapacityError);
  });

  it.each(automationBuilderToolContract.operations)("admits the final root envelope for $operationId including selected targets", async (operation) => {
    const params = { title: "  " + "界".repeat(150) + "  ", automationId: "draft-target", expectedRevision: 1 };
    const references = projectToolTargetReferences(operation.selectionControlIds.map((key) => ({
      type: "selected_control", target: typeof params[key] === "string" ? params[key] : undefined,
    })));
    const baseBytes = Buffer.byteLength(JSON.stringify(envelope(JSON.stringify({ text: "" }))));
    const withoutRefsFits = { text: "x".repeat(CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES - baseBytes) };
    const serialized = JSON.stringify(withoutRefsFits);
    expect(normalizeCapabilityAdapterResult(envelope(serialized)).ok).toBe(true);
    expect(normalizeCapabilityAdapterResult(envelope(serialized, references))).toMatchObject({ ok: false, code: "result_too_large" });
    expect(() => prepareAutomationDraftReceipt(withoutRefsFits, { tool: "automation_builder", operation, params, mutationEvidence: true }))
      .toThrow(AutomationDraftReceiptCapacityError);

    const fullBaseBytes = Buffer.byteLength(JSON.stringify(envelope(JSON.stringify({ text: "" }), references)));
    const exactFit = { text: "x".repeat(CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES - fullBaseBytes) };
    const prepared = prepareAutomationDraftReceipt(exactFit, { tool: "automation_builder", operation, params, mutationEvidence: true });
    const executed = await executeToolCall({ tool: "automation_builder", params: {} }, {
      implementations: { automation_builder: async () => prepared },
    });
    const exactResult = captureRegisteredToolResult({ status: "executed", effect: "mutating", result: executed, completionActions: [] });
    const final = attachTargetReferences({ outcome: "succeeded", observedEffect: "mutation", summary: "Saved", exactResult }, references);
    expect(Buffer.byteLength(JSON.stringify(final.exactResult))).toBe(CAPABILITY_ADAPTER_RESULT_SERIALIZED_MAX_BYTES);
    expect(executed.output).toBe(prepared.output);
    expect(normalizeCapabilityAdapterResult(final.exactResult).ok).toBe(true);
  });
});
