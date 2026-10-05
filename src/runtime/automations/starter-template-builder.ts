import { randomUUID } from "node:crypto";
import type { AutomationCatalogOperation } from "./catalog.js";
import type { AutomationRevision, SequenceNode, ValueBinding, WorkflowNode } from "./definition-contracts.js";
import { parseAutomationDefinition } from "./definition-input.js";
import type { AutomationStarter, StarterStep, StarterToolStep } from "./starter-template-contracts.js";

type StarterResultScope = {
  nodes: Map<string, string>;
  groups: Map<string, string>;
};

function nodeId(): string {
  return `n_${randomUUID().replaceAll("-", "")}`;
}

function requiredResultId(key: string, ids: ReadonlyMap<string, string>): string {
  const id = ids.get(key);
  if (!id) throw new Error("automation_template_invalid");
  return id;
}

function earlierStepText(key: string, scope: StarterResultScope): ValueBinding {
  return { kind: "node_result", nodeId: requiredResultId(key, scope.nodes), select: "text" };
}

function runInputBinding(starter: AutomationStarter, key: string): ValueBinding {
  if (!Object.hasOwn(starter.inputs ?? {}, key)) throw new Error("automation_template_invalid");
  return { kind: "run_input", input: key };
}

/** Materialize recipes into the existing graph contract; branch-local results stay local until the join. */
export function buildStarterDefinition(
  starter: AutomationStarter,
  base: AutomationRevision,
  selectOperation: (step: StarterToolStep) => AutomationCatalogOperation | undefined,
): AutomationRevision {
  const keys = new Set<string>();

  function reserveKey(key: string): string {
    if (keys.has(key)) throw new Error("automation_template_invalid");
    keys.add(key);
    return nodeId();
  }

  function buildSequence(steps: readonly StarterStep[], scope: StarterResultScope): SequenceNode {
    return { kind: "sequence", id: nodeId(), children: steps.map((step) => buildStep(step, scope)) };
  }

  function buildStep(step: StarterStep, scope: StarterResultScope): WorkflowNode {
    const id = reserveKey(step.key);
    if (step.kind === "parallel") {
      const branches = step.branches.map((steps) => {
        const branchScope = { nodes: new Map(scope.nodes), groups: new Map(scope.groups) };
        return { sequence: buildSequence(steps, branchScope), scope: branchScope };
      });
      for (const branch of branches) {
        for (const [key, value] of branch.scope.nodes) scope.nodes.set(key, value);
        for (const [key, value] of branch.scope.groups) scope.groups.set(key, value);
      }
      scope.groups.set(step.key, id);
      return { kind: "parallel", id, branches: branches.map((branch) => branch.sequence) };
    }
    if (step.kind === "tool") {
      const operation = selectOperation(step);
      if (!operation) throw new Error("automation_template_unavailable");
      const payload = step.payloadFrom ? earlierStepText(step.payloadFrom, scope) : undefined;
      const controls: Record<string, ValueBinding> = Object.fromEntries(
        Object.entries(step.controls ?? {}).map(([name, value]) => [name, { kind: "literal", value }]),
      );
      for (const [name, key] of Object.entries(step.controlInputs ?? {}))
        controls[name] = runInputBinding(starter, key);
      if (step.outputFile) controls.path = { kind: "run_file", fileName: step.outputFile };
      scope.nodes.set(step.key, id);
      return { kind: "tool", id, title: step.title, onFailure: "stop",
        operation: { toolName: operation.toolName, operationId: operation.operationId,
          contractVersion: operation.contractVersion }, controls, ...(payload ? { payload } : {}) };
    }
    const inputs: Record<string, ValueBinding> = Object.fromEntries(
      step.sources.map((key) => [key, earlierStepText(key, scope)]),
    );
    for (const key of step.parallelSources ?? [])
      inputs[key] = { kind: "branch_results", parallelNodeId: requiredResultId(key, scope.groups) };
    for (const key of step.runInputs ?? []) inputs[key] = runInputBinding(starter, key);
    scope.nodes.set(step.key, id);
    return { kind: "agent", id, title: step.title, onFailure: "stop",
      modelProfileId: "", agentMode: "fast", roleInstructions: step.role,
      prompt: step.prompt, inputs, tools: [], result: { kind: "text" } };
  }

  const body = buildSequence(starter.steps, { nodes: new Map(), groups: new Map() });
  return parseAutomationDefinition({ ...base, title: starter.title, objective: starter.objective,
    inputs: structuredClone(starter.inputs ?? base.inputs), body: { ...body, id: base.body.id },
    limits: { ...base.limits, ...(starter.maxModelCallsPerRun
      ? { maxModelCallsPerRun: starter.maxModelCallsPerRun } : {}) } });
}
