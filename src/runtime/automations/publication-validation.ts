import { captureRequestReasoningPreference } from "../request/reasoning-preference.js";
import type { RuntimeConfig } from "../ports.js";
import { resolveModelSelection } from "../model/model-selection.js";
import {
  validateToolNormalInvocationInput,
  validateToolNormalInvocationPayload,
} from "../../capabilities/normal-invocation/validator.js";
import type { AutomationRevision, OperationRef } from "./definition-contracts.js";
import type { ToolNode } from "./definition-contracts.js";
import { compileAutomationGraph, type AutomationGraphIssue } from "./graph-validation.js";
import type { AutomationCatalogOperation } from "./catalog.js";
import { sourceAttachmentIssue } from "./source-attachment-access.js";
import { validateAutomationWorkingDirectory } from "./working-directory.js";
import { normalizeAutomationSchedule, requireAutomationScheduleOccurrence,
  hasAutomationScheduleTimingChanged, type AutomationScheduleTiming } from "../scheduler/automation-schedule.js";
import { validateTimeZone } from "../scheduler/schedule-validation.js";
import { SchedulerValidationError } from "../scheduler/validation-error.js";
import { automationTriggerSchedule } from "./trigger-schedule.js";

function validateTriggerSchedule(definition: AutomationRevision, now: number, timeZone: string,
  checkScheduleReadiness: boolean, existingSchedule?: AutomationScheduleTiming): AutomationGraphIssue[] {
  const trigger = definition.trigger;
  if (trigger.kind === "manual") return [];
  if (trigger.kind !== "schedule" && trigger.kind !== "folder") return [];
  const schedule = automationTriggerSchedule(trigger);
  try {
    const normalized = normalizeAutomationSchedule(schedule, now, existingSchedule);
    if (!checkScheduleReadiness) return [];
    validateTimeZone(timeZone);
    if (!hasAutomationScheduleTimingChanged(normalized, timeZone, existingSchedule)) return [];
    requireAutomationScheduleOccurrence(normalized, timeZone, now);
    return [];
  } catch (error) {
    if (!(error instanceof SchedulerValidationError)) throw error;
    return [{ code: error.code, message: error.message,
      path: trigger.kind === "schedule" ? "trigger.schedule" : "trigger.checkEveryMs" }];
  }
}

function matchesOperation(candidate: AutomationCatalogOperation, selected: OperationRef): boolean {
  return candidate.toolName === selected.toolName &&
    candidate.operationId === selected.operationId &&
    candidate.contractVersion === selected.contractVersion;
}

function validateToolNodeInputs(node: ToolNode, operation: AutomationCatalogOperation): AutomationGraphIssue[] {
  const issues: AutomationGraphIssue[] = [];
  for (const required of operation.input.required) {
    if (!Object.hasOwn(node.controls, required)) issues.push({
      code: "automation_tool_input_missing",
      path: `nodes.${node.id}.controls.${required}`,
      message: `Configure the required ${required} input before publishing.`,
    });
  }
  const literalValues: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(node.controls)) {
    if (!Object.hasOwn(operation.input.properties, name)) issues.push({
      code: "automation_tool_input_invalid",
      path: `nodes.${node.id}.controls.${name}`,
      message: "This input is not part of the selected operation.",
    });
    else if (binding.kind === "literal") literalValues[name] = binding.value;
  }
  const contract = {
    operationId: operation.operationId,
    summary: operation.label,
    input: {
      ...operation.input,
      required: operation.input.required.filter((name) => Object.hasOwn(literalValues, name)),
    },
    effect: operation.effect,
    approval: operation.approval,
    ...(operation.payload ? { payload: operation.payload } : {}),
  } as const;
  const literalInput = validateToolNormalInvocationInput(contract, literalValues);
  if (!literalInput.ok) issues.push({
    code: "automation_tool_input_invalid",
    path: `nodes.${node.id}.controls`,
    message: literalInput.issue,
  });
  if (operation.payload?.minBytes && !node.payload) issues.push({
    code: "automation_tool_input_missing",
    path: `nodes.${node.id}.payload`,
    message: "Configure the required text input before publishing.",
  });
  if (node.payload?.kind === "literal") {
    const payloadIssue = validateToolNormalInvocationPayload(contract, node.payload.value);
    if (payloadIssue) issues.push({
      code: "automation_tool_input_invalid",
      path: `nodes.${node.id}.payload`,
      message: payloadIssue,
    });
  }
  return issues;
}

export function validateAutomationPublication(input: {
  definition: AutomationRevision;
  config: RuntimeConfig;
  operations: readonly AutomationCatalogOperation[];
  grantMode: "full_access" | "full_plus";
  now?: number;
  timeZone?: string;
  /** Replaying a frozen run does not create a new scheduled occurrence. */
  checkScheduleReadiness?: boolean;
  existingSchedule?: AutomationScheduleTiming;
}): readonly AutomationGraphIssue[] {
  const workingDirectoryIssue = validateAutomationWorkingDirectory(input.definition.workingDirectory);
  if (workingDirectoryIssue) return [workingDirectoryIssue];
  const compiled = compileAutomationGraph(input.definition);
  if (!compiled.ok) return compiled.issues;
  const issues: AutomationGraphIssue[] = validateTriggerSchedule(input.definition, input.now ?? Date.now(),
    input.timeZone ?? "UTC", input.checkScheduleReadiness !== false, input.existingSchedule);
  let sourceMayReceiveGeneratedFiles = false;
  if (input.definition.trigger.kind !== "manual" && input.definition.trigger.kind !== "schedule" &&
      input.definition.trigger.kind !== "folder") {
    issues.push({ code: "automation_graph_invalid", path: "trigger", message: "Choose a supported trigger." });
  }
  for (const step of compiled.graph.steps) {
    const node = step.node;
    const sourceIssue = sourceAttachmentIssue(node, input.operations);
    if (sourceIssue) issues.push({
      code: sourceIssue,
      path: `nodes.${node.id}.${node.kind === "agent" ? "inputs" : "controls"}`,
      message: "Select an operation that accepts frozen source files, or remove this snapshot binding.",
    });
    const selections = node.kind === "tool"
      ? [node.operation]
      : node.tools.map((tool) => tool.operation);
    for (const [index, selected] of selections.entries()) {
      const operation = input.operations.find((entry) => matchesOperation(entry, selected));
      const path = node.kind === "tool"
        ? `nodes.${node.id}.operation`
        : `nodes.${node.id}.tools.${index}`;
      if (!operation) {
        issues.push({ code: "automation_operation_unavailable", path, message: "Grant and configure this operation before publishing." });
        continue;
      }
      if (node.kind === "tool") issues.push(...validateToolNodeInputs(node, operation));
      if (operation.effect !== "read_only") sourceMayReceiveGeneratedFiles = true;
      if (operation.approval === "always" && input.grantMode !== "full_plus") {
        issues.push({ code: "automation_approval_required", path, message: "This operation needs an interactive approval in Full mode." });
      }
    }
    if (node.kind !== "agent") continue;
    const selection = resolveModelSelection({
      agentMode: node.agentMode,
      modelPreference: { profileId: node.modelProfileId, scope: "all" },
      modelPolicy: input.config.models,
      modelExecutionPolicies: input.config.modelExecutionPolicies,
    });
    try {
      captureRequestReasoningPreference(node.reasoningPreference, selection);
    } catch (error) {
      issues.push({ code: "automation_model_unavailable", path: `nodes.${node.id}.reasoningPreference`, message: String(error) });
    }
    if (selection.execution.primaryProfileId !== node.modelProfileId) {
      issues.push({
        code: "automation_model_unavailable",
        path: `nodes.${node.id}.modelProfileId`,
        message: "The selected model profile is not available for this Agent.",
      });
    }
  }
  if (input.definition.source && sourceMayReceiveGeneratedFiles &&
      input.definition.source.excludePatterns.length === 0) {
    issues.push({
      code: "automation_source_exclusions_required",
      path: "source.excludePatterns",
      message: "Exclude output and archive paths so generated files do not re-enter this folder workflow.",
    });
  }
  return issues;
}
