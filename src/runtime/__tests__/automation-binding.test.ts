import { describe, expect, it } from "vitest";

import {
  resolveAutomationBinding,
  type AutomationBindingContext,
} from "../automations/binding-resolution.js";
import { decideAutomationFailureDisposition } from "../automations/failure-policy.js";

function context(): AutomationBindingContext {
  return {
    runInputs: { presentNull: null, count: 0 },
    sourceFiles: [{
      inputId: "input-1", sourceId: "source-1", originalPath: "/source/one.pdf",
      snapshotPath: "/snapshots/one.pdf", version: "content-hash", sizeBytes: 25,
    }],
    nodeResults: new Map([
      ["parsed", { status: "succeeded", data: { verdict: null, amount: 0 } }],
      ["skipped", { status: "skipped" }],
    ]),
    branchResults: new Map([["parallel", [
      { nodeId: "parsed", status: "succeeded", resultRef: "result-1" },
      { nodeId: "skipped", status: "skipped" },
    ]]]),
  };
}

describe("automation binding resolution", () => {
  it("distinguishes a present null result from a missing dependency", () => {
    const bindings = context();
    expect(resolveAutomationBinding({ kind: "run_input", input: "presentNull" }, bindings))
      .toEqual({ ok: true, value: null });
    expect(resolveAutomationBinding({
      kind: "node_result", nodeId: "parsed", select: "data", pointer: "/verdict",
    }, bindings)).toEqual({ ok: true, value: null });
    expect(resolveAutomationBinding({ kind: "run_input", input: "unknown" }, bindings))
      .toEqual({ ok: false, code: "automation_dependency_missing" });
    expect(resolveAutomationBinding({
      kind: "node_result", nodeId: "skipped", select: "text",
    }, bindings)).toEqual({ ok: false, code: "automation_dependency_missing" });
  });

  it("returns frozen source identity from the selected run manifest", () => {
    const bindings = context();
    expect(resolveAutomationBinding({
      kind: "source_file", index: 0, field: "snapshot_path",
    }, bindings)).toEqual({ ok: true, value: "/snapshots/one.pdf" });
    expect(resolveAutomationBinding({ kind: "source_files" }, bindings)).toMatchObject({
      ok: true,
      value: [{ inputId: "input-1", snapshotPath: "/snapshots/one.pdf" }],
    });
    expect(resolveAutomationBinding({
      kind: "source_file", index: 1, field: "snapshot_path",
    }, bindings)).toEqual({ ok: false, code: "automation_dependency_missing" });
  });

  it("rejects prototype traversal while preserving post-join failure status", () => {
    const bindings = context();
    expect(resolveAutomationBinding({
      kind: "node_result", nodeId: "parsed", select: "data", pointer: "/__proto__",
    }, bindings)).toEqual({ ok: false, code: "automation_output_pointer_invalid" });
    expect(resolveAutomationBinding({
      kind: "branch_results", parallelNodeId: "parallel",
    }, bindings)).toMatchObject({ ok: true, value: [
      { nodeId: "parsed", status: "succeeded" },
      { nodeId: "skipped", status: "skipped" },
    ] });
  });

  it("materializes selected parallel outputs without leaking other steps or inventing skipped output", () => {
    const bindings = context();
    const results = new Map(bindings.nodeResults);
    results.set("parsed", { status: "succeeded", text: "Verified input", data: { amount: 0 } });
    results.set("unrelated", { status: "succeeded", text: "Private unrelated value" });
    const binding = { kind: "branch_results", parallelNodeId: "parallel" } as const;
    expect(resolveAutomationBinding(binding, { ...bindings, nodeResults: results }))
      .toEqual({ ok: true, value: [
        { nodeId: "parsed", status: "succeeded", resultRef: "result-1",
          text: "Verified input", data: { amount: 0 } },
        { nodeId: "skipped", status: "skipped" },
      ] });
    results.delete("parsed");
    expect(resolveAutomationBinding(binding, { ...bindings, nodeResults: results }))
      .toEqual({ ok: false, code: "automation_dependency_missing" });
  });
});

describe("automation failure policy", () => {
  it("can skip a definite failure but always stops on an uncertain effect", () => {
    expect(decideAutomationFailureDisposition("skip", "definite_failure"))
      .toEqual({ kind: "skip", reason: "definite_failure" });
    expect(decideAutomationFailureDisposition("skip", "effect_uncertain"))
      .toEqual({ kind: "stop", reason: "effect_uncertain" });
  });
});
