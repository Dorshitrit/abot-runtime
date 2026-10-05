import { describe, expect, it } from "vitest";

import type {
  AgentNode,
  AutomationRevision,
  ParallelNode,
  SequenceNode,
  ToolNode,
  ValueBinding,
} from "../automations/definition-contracts.js";
import { compileAutomationGraph, validateAutomationGraph } from "../automations/graph-validation.js";
import { DEFAULT_AUTOMATION_LIMITS } from "../automations/limits.js";

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { verdict: { type: "string", minLength: 1, maxLength: 24 } },
  required: ["verdict"],
} as const;

function agent(id: string, inputs: Record<string, ValueBinding> = {}): AgentNode {
  return {
    kind: "agent", id, title: id, onFailure: "stop",
    modelProfileId: "test-model", agentMode: "fast",
    roleInstructions: "Review the provided input.", prompt: "Review.",
    inputs, tools: [], result: { kind: "json", schema: RESULT_SCHEMA },
  };
}

function tool(id: string, controls: Record<string, ValueBinding> = {}): ToolNode {
  return {
    kind: "tool", id, title: id, onFailure: "stop",
    operation: { toolName: "fixture", operationId: "record", contractVersion: 1 },
    controls,
  };
}

function sequence(id: string, children: SequenceNode["children"]): SequenceNode {
  return { kind: "sequence", id, children };
}

function definition(body: SequenceNode): AutomationRevision {
  return {
    schemaVersion: 1, automationId: "automation-one", revision: 1,
    title: "Example", objective: "Process exact inputs", trigger: { kind: "manual" },
    inputs: { invoiceId: "invoice-1" }, body, limits: DEFAULT_AUTOMATION_LIMITS,
  };
}

describe("automation graph validation", () => {
  it("accepts a sequential result, independent parallel branches and a post-join consumer", () => {
    const branches: ParallelNode = {
      kind: "parallel", id: "reviews", branches: [
        sequence("left", [agent("review-left", { source: { kind: "run_input", input: "invoiceId" } })]),
        sequence("right", [agent("review-right", { source: { kind: "run_input", input: "invoiceId" } })]),
      ],
    };
    const body = sequence("root", [
      tool("load"), branches,
      agent("combine", {
        loaded: { kind: "node_result", nodeId: "load", select: "text" },
        reviews: { kind: "branch_results", parallelNodeId: "reviews" },
      }),
    ]);
    expect(validateAutomationGraph(definition(body))).toEqual([]);
    const compiled = compileAutomationGraph(definition(body));
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.graph.steps.map(({ id, dependsOn }) => [id, dependsOn])).toEqual([
      ["load", []],
      ["review-left", ["load"]],
      ["review-right", ["load"]],
      ["combine", ["review-left", "review-right"]],
    ]);
    expect(compiled.graph.parallelGroups).toEqual([{
      id: "reviews", branches: [["review-left"], ["review-right"]],
      tailNodeIds: ["review-left", "review-right"],
    }]);
  });

  it("rejects a sibling branch dependency and a forward reference", () => {
    const body = sequence("root", [
      tool("first", { next: { kind: "node_result", nodeId: "later", select: "text" } }),
      {
        kind: "parallel", id: "split", branches: [
          sequence("left", [tool("later")]),
          sequence("right", [tool("right-tool", {
            sibling: { kind: "node_result", nodeId: "later", select: "text" },
          })]),
        ],
      },
    ]);
    expect(validateAutomationGraph(definition(body)).filter(
      (entry) => entry.code === "automation_dependency_missing",
    )).toHaveLength(2);
  });

  it("rejects unsafe result paths, mismatched result types and duplicate IDs", () => {
    const textAgent = { ...agent("reader"), result: { kind: "text" as const } };
    const body = sequence("root", [
      textAgent,
      tool("reader", {
        unsafe: { kind: "node_result", nodeId: "reader", select: "data", pointer: "/__proto__" },
      }),
    ]);
    const codes = validateAutomationGraph(definition(body)).map((entry) => entry.code);
    expect(codes).toContain("automation_node_id_duplicate");
    expect(codes).toContain("automation_dependency_missing");
    expect(codes).toContain("automation_output_pointer_invalid");
  });

  it("requires a source for folder triggers and source bindings", () => {
    const revision = definition(sequence("root", [
      agent("reader", { files: { kind: "source_files" } }),
    ]));
    const codes = validateAutomationGraph({
      ...revision, trigger: { kind: "folder", checkEveryMs: 60_000, minimumEligibleFiles: 1 },
    }).map((entry) => entry.code);
    expect(codes).toContain("automation_source_unavailable");
    expect(codes).toContain("automation_dependency_missing");
  });

  it("does not accept unbounded JSON output or prose acceptance checks", () => {
    const invalidAgent: AgentNode = {
      ...agent("judge"), result: {
        kind: "json", schema: {
          type: "object", additionalProperties: false,
          properties: { verdict: { type: "string", minLength: 0 } },
          required: ["verdict"],
        },
      },
      acceptance: [{ field: "missing", equals: "yes" }],
    };
    const codes = validateAutomationGraph(definition(sequence("root", [invalidAgent])))
      .map((entry) => entry.code);
    expect(codes).toContain("automation_output_schema_invalid");
    expect(codes).toContain("automation_acceptance_invalid");
  });
});
