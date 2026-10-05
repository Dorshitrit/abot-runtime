import { expect, test } from "vitest";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { parseAutomationDefinition } from "../automations/definition-input.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { resolveAutomationBinding } from "../automations/binding-resolution.js";
import { automationRunFilePath, isAutomationRunFileName } from "../automations/run-file-binding.js";

function definition(fileName: string) {
  const base = createEmptyAutomationDefinition("automation", "Save a new report");
  return { ...base, body: { ...base.body, children: [{
    kind: "tool" as const, id: "save", title: "Save", onFailure: "stop" as const,
    operation: { toolName: "write_file", operationId: "write_complete_file", contractVersion: 1 },
    controls: { path: { kind: "run_file" as const, fileName } },
    payload: { kind: "literal" as const, value: "Report" },
  }] } };
}

test("a run-owned file binding is stable inside one run and distinct in a later run", () => {
  const parsed = parseAutomationDefinition(definition("brief.md"));
  expect(compileAutomationGraph(parsed).ok).toBe(true);
  const context = { runInputs: {}, sourceFiles: [], nodeResults: new Map(), branchResults: new Map() };
  const binding = { kind: "run_file", fileName: "brief.md" } as const;
  expect(resolveAutomationBinding(binding, { ...context, runId: "run-one" }))
    .toEqual({ ok: true, value: "automation-output/run-one/brief.md" });
  expect(resolveAutomationBinding(binding, { ...context, runId: "run-two" }))
    .toEqual({ ok: true, value: "automation-output/run-two/brief.md" });
  expect(resolveAutomationBinding(binding, context))
    .toEqual({ ok: false, code: "automation_dependency_missing" });
});

test.each(["../brief.md", "/brief.md", "C:\\brief.md", "nested/brief.md", "..", "NUL.txt", "COM1", "brief.md ", "brief.", "bad\u0000.md"])(
  "rejects unsafe or nonportable output name %j before running a step", (fileName) => {
    expect(isAutomationRunFileName(fileName)).toBe(false);
    expect(automationRunFilePath("run-one", fileName)).toBeNull();
    expect(() => parseAutomationDefinition(definition(fileName))).toThrow();
    expect(compileAutomationGraph(definition(fileName))).toMatchObject({ ok: false,
      issues: [expect.objectContaining({ code: "automation_run_file_invalid" })] });
  },
);

test("never treats user input as the run identifier", () => {
  expect(automationRunFilePath("../another-run", "brief.md")).toBeNull();
  expect(automationRunFilePath("real-run", "סיכום.md"))
    .toBe("automation-output/real-run/סיכום.md");
});
