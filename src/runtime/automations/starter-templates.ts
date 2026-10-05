import { validateToolNormalInvocationInput } from "../../capabilities/normal-invocation/validator.js";
import type { AutomationCatalogOperation } from "./catalog.js";
import type { AutomationRevision } from "./definition-contracts.js";
import { automationRunFilePath } from "./run-file-binding.js";
import { AUTOMATION_STARTERS } from "./starter-template-definitions.js";
import type { AutomationStarter, StarterToolStep } from "./starter-template-contracts.js";
import { buildStarterDefinition } from "./starter-template-builder.js";
import { isStarterToolStep, walkStarterSteps } from "./starter-template-structure.js";

function hasCompatibleStarterControls(
  step: StarterToolStep, operation: AutomationCatalogOperation, starter: AutomationStarter,
): boolean {
  const controlInputs = Object.entries(step.controlInputs ?? {});
  if (controlInputs.some(([, key]) => !Object.hasOwn(starter.inputs ?? {}, key))) return false;
  const values = { ...step.controls,
    ...Object.fromEntries(controlInputs.map(([name, key]) => [name, starter.inputs![key]])),
    ...(step.outputFile ? { path: automationRunFilePath("template-run", step.outputFile) } : {}) };
  if (Object.keys(values).some((name) => !Object.hasOwn(operation.input.properties, name))) return false;
  const contract = {
    operationId: operation.operationId, summary: operation.label,
    input: { ...operation.input,
      required: operation.input.required.filter((name) => Object.hasOwn(values, name)) },
    effect: operation.effect, approval: operation.approval,
    ...(operation.payload ? { payload: operation.payload } : {}),
  } as const;
  return validateToolNormalInvocationInput(contract, values).ok;
}

function matchesStarterOperation(
  step: StarterToolStep, candidate: AutomationCatalogOperation, starter: AutomationStarter,
): boolean {
  if (candidate.toolName !== step.toolName) return false;
  if (candidate.operationId !== step.operationId) return false;
  if (candidate.effect !== (step.effect ?? "read_only")) return false;
  // A new draft cannot inherit or manufacture a FULL+ grant.
  if (candidate.permissionMode === "full_plus") return false;
  if (candidate.approval !== "request_policy") return false;
  if (step.payloadFrom && candidate.payload?.kind !== "raw_text") return false;
  if (!step.payloadFrom && candidate.payload) return false;
  return hasCompatibleStarterControls(step, candidate, starter);
}

function findAvailableOperation(
  step: StarterToolStep, operations: readonly AutomationCatalogOperation[], starter: AutomationStarter,
) {
  return operations.find((candidate) => matchesStarterOperation(step, candidate, starter));
}

function isStarterAvailable(starter: AutomationStarter, operations: readonly AutomationCatalogOperation[]): boolean {
  return walkStarterSteps(starter.steps).filter(isStarterToolStep)
    .every((step) => Boolean(findAvailableOperation(step, operations, starter)));
}

export function listAutomationStarters(operations: readonly AutomationCatalogOperation[]) {
  return AUTOMATION_STARTERS.filter((starter) => isStarterAvailable(starter, operations)).slice(0, 10).map((starter) => {
    const steps = walkStarterSteps(starter.steps);
    const tools = steps.filter(isStarterToolStep);
    return {
      id: starter.id, title: starter.title, category: starter.category,
      description: starter.description, setup: starter.setup,
      toolNames: [...new Set(tools.map((step) => step.toolName))],
      stepCount: steps.filter((step) => step.kind !== "parallel").length,
      agentCount: steps.filter((step) => step.kind === "agent").length,
      parallelGroupCount: steps.filter((step) => step.kind === "parallel").length,
      level: starter.level ?? "starter", highlights: starter.highlights ?? [],
      outputFiles: tools.flatMap((step) => step.outputFile ? [step.outputFile] : []),
    };
  });
}

export function prepareAutomationStarter(id: string, operations: readonly AutomationCatalogOperation[]) {
  const starter = AUTOMATION_STARTERS.find((item) => item.id === id);
  if (!starter || !isStarterAvailable(starter, operations))
    throw new Error("automation_template_unavailable");
  return {
    title: starter.title,
    buildDefinition(base: AutomationRevision): AutomationRevision {
      return buildStarterDefinition(starter, base, (step) => findAvailableOperation(step, operations, starter));
    },
  };
}
