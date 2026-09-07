import { readStructuredDecisionEnvelope } from "../../model/structured-decision-envelope.js";
import {
  isMemoryRecallDecisionRecord,
  parseMemoryRecallDecision,
} from "../memory-recall-decision.js";
import {
  EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
  EXECUTION_AGENT_TITLE_MAX_LENGTH,
  EXECUTION_AGENT_AUDIT_CRITERION_COUNT_MAX,
  EXECUTION_AGENT_AUDIT_CRITERION_ID_MAX_LENGTH,
  EXECUTION_AGENT_DECISION_ACTIONS,
  EXECUTION_AGENT_RESPONSE_MAX_LENGTH,
  type ExecutionAgentDecision,
  type ExecutionAgentDecisionContractOptions,
  type ExecutionAgentDecisionParseResult,
  type ExecutionAgentDecisionValidationIssue,
  type ExecutionAgentExtendCapabilityScopeDecision,
  type ExecutionAgentOpenCapabilityScopeDecision,
} from "./contracts.js";
import { prepareExecutionAgentDecisionContract } from "./format.js";
import {
  parseCapabilityCatalogGroupIds,
  parseCapabilityBatch,
  parseCapabilityInvocation,
  parseWorkingDirectory,
} from "./capability-decision-parsing.js";
import {
  parsePresentation,
  presentationKeys,
  exactPresentationKeys,
  validateObjective,
  parseBoundedTextArray,
  validateBoundedText,
  readAction,
  exactKeys,
  rejectEnvelope,
  issue,
  asRecord,
  deepFreeze,
} from "./decision-validation.js";

export function parseExecutionAgentDecisionOutput(
  text: string,
  options: ExecutionAgentDecisionContractOptions = {},
): ExecutionAgentDecisionParseResult {
  const contract = prepareExecutionAgentDecisionContract(options);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim()) as unknown;
  } catch {
    return rejectEnvelope([
      issue(
        "execution_agent_output_not_json",
        "decision",
        "Expected one JSON object.",
      ),
    ]);
  }
  if (!asRecord(decoded)) {
    return rejectEnvelope([
      issue(
        "execution_agent_output_not_object",
        "decision",
        "Expected one JSON object.",
      ),
    ]);
  }
  const record = readStructuredDecisionEnvelope(decoded);
  if (!record) {
    return rejectEnvelope([
      issue(
        "execution_agent_output_envelope_invalid",
        "decision",
        "Expected exactly one decision object inside the canonical envelope.",
      ),
    ]);
  }

  if (isMemoryRecallDecisionRecord(record)) {
    return parseMemoryRecallDecision(record, {
      allowMemoryRecall: contract.allowMemoryRecall,
      includeAcknowledgement: contract.includeAcknowledgement,
      includeTitle: contract.includeTitle,
      acknowledgementMaxLength: EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
      titleMaxLength: EXECUTION_AGENT_TITLE_MAX_LENGTH,
    });
  }

  const issues: ExecutionAgentDecisionValidationIssue[] = [];
  const selectedAction = readAction(record.action);
  if (!selectedAction) {
    issues.push(
      issue(
        "execution_agent_action_invalid",
        "decision.action",
        `Action must be one of: ${EXECUTION_AGENT_DECISION_ACTIONS.join(", ")}.`,
      ),
    );
  }
  const presentation = parsePresentation(record, contract, issues);
  let decision: ExecutionAgentDecision | undefined;

  if (selectedAction === "open_capability_scope") {
    exactKeys(
      record,
      ["action", "catalogGroupIds", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    const catalogGroupIds = parseCapabilityCatalogGroupIds(
      record.catalogGroupIds,
      contract.capabilityCatalogGroupIds,
      issues,
    );
    if (
      contract.activeCapabilityCatalogGroupIds !== null ||
      contract.capabilityCatalogGroupIds.length === 0
    ) {
      issues.push(
        issue(
          "execution_agent_capability_scope_open_unavailable",
          "decision.action",
          "open_capability_scope is available only while the canonical capability scope is closed.",
        ),
      );
    }
    if (catalogGroupIds) {
      decision = {
        action: "open_capability_scope",
        catalogGroupIds,
        ...presentation,
      } satisfies ExecutionAgentOpenCapabilityScopeDecision;
    }
  } else if (selectedAction === "respond") {
    exactKeys(
      record,
      ["action", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    if (!contract.allowRespond) {
      issues.push(
        issue(
          "execution_agent_response_not_allowed",
          "decision.action",
          "respond is not available until the canonical completion gate is open.",
        ),
      );
    }
    decision = {
      action: "respond",
      ...presentation,
    };
  } else if (selectedAction === "blocked") {
    exactKeys(
      record,
      ["action", "response", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    const response = validateBoundedText({
      value: record.response,
      maximumLength: EXECUTION_AGENT_RESPONSE_MAX_LENGTH,
      code: "execution_agent_response_invalid",
      path: "decision.response",
      label: "Response",
      issues,
    });
    if (response !== undefined) {
      decision = {
        action: "blocked",
        response,
        ...presentation,
      };
    }
  } else if (selectedAction === "invoke_capability") {
    const invocation = parseCapabilityInvocation({
      value: record,
      path: "decision",
      capabilities: contract.capabilities,
      observationOnly: false,
      includesAction: true,
      issues,
    });
    exactPresentationKeys(
      record,
      contract,
      [
        ...invocation.expectedKeys,
        ...(contract.includeWorkingDirectory ? ["workingDirectory"] : []),
      ],
      issues,
    );
    const workingDirectory = parseWorkingDirectory(record, contract, issues);
    if (invocation.value) {
      decision = {
        action: "invoke_capability",
        ...invocation.value,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...presentation,
      };
    }
  } else if (selectedAction === "invoke_capabilities") {
    exactKeys(
      record,
      [
        "action",
        "invocations",
        ...(contract.includeWorkingDirectory ? ["workingDirectory"] : []),
        ...presentationKeys(contract),
      ],
      issues,
      "decision",
    );
    const invocations = parseCapabilityBatch(
      record.invocations,
      contract,
      issues,
    );
    const workingDirectory = parseWorkingDirectory(record, contract, issues);
    if (invocations) {
      decision = {
        action: "invoke_capabilities",
        invocations,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...presentation,
      };
    }
  } else if (selectedAction === "extend_capability_scope") {
    exactKeys(
      record,
      ["action", "catalogGroupIds", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    const catalogGroupIds = parseCapabilityCatalogGroupIds(
      record.catalogGroupIds,
      contract.inactiveCapabilityCatalogGroupIds,
      issues,
    );
    if (
      contract.activeCapabilityCatalogGroupIds === null ||
      contract.inactiveCapabilityCatalogGroupIds.length === 0
    ) {
      issues.push(
        issue(
          "execution_agent_capability_scope_extend_unavailable",
          "decision.action",
          "extend_capability_scope is available only while a canonical capability scope is active and at least one inactive group is offered.",
        ),
      );
    }
    if (catalogGroupIds) {
      decision = {
        action: "extend_capability_scope",
        catalogGroupIds,
        ...presentation,
      } satisfies ExecutionAgentExtendCapabilityScopeDecision;
    }
  } else if (selectedAction === "invoke_planner") {
    exactKeys(
      record,
      ["action", "objective", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    if (!contract.allowPlanner) {
      issues.push(
        issue(
          "execution_agent_planner_not_allowed",
          "decision.action",
          "Planner invocation is not available for this decision.",
        ),
      );
    }
    const objective = validateObjective(record.objective, issues);
    if (objective !== undefined) {
      decision = {
        action: "invoke_planner",
        objective,
        ...presentation,
      };
    }
  } else if (selectedAction === "invoke_auditor") {
    exactKeys(
      record,
      ["action", "criterionIds", ...presentationKeys(contract)],
      issues,
      "decision",
    );
    if (
      !contract.allowAuditor ||
      contract.availableAuditCriterionIds.length === 0
    ) {
      issues.push(
        issue(
          "execution_agent_auditor_not_allowed",
          "decision.action",
          "Auditor invocation is not available for this decision.",
        ),
      );
    }
    const criterionIds = parseBoundedTextArray({
      value: record.criterionIds,
      path: "decision.criterionIds",
      code: "execution_agent_audit_criteria_invalid",
      label: "Audit criterion ids",
      itemMaximumLength: EXECUTION_AGENT_AUDIT_CRITERION_ID_MAX_LENGTH,
      maximumItems: EXECUTION_AGENT_AUDIT_CRITERION_COUNT_MAX,
      issues,
    });
    if (
      criterionIds?.some(
        (criterionId) =>
          !contract.availableAuditCriterionIds.includes(criterionId),
      )
    ) {
      issues.push(
        issue(
          "execution_agent_audit_criteria_unavailable",
          "decision.criterionIds",
          "criterionIds must identify unresolved semantic criteria offered by the runtime.",
        ),
      );
    }
    if (criterionIds) {
      decision = {
        action: "invoke_auditor",
        criterionIds,
        ...presentation,
      };
    }
  }

  if (issues.length > 0 || !decision) {
    return {
      ok: false,
      stage: "domain_parser",
      issues: Object.freeze(issues),
    };
  }
  return {
    ok: true,
    decision: deepFreeze(structuredClone(decision)),
  };
}
