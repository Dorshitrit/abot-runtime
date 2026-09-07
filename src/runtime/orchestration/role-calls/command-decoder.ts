import { isRuntimeDelegateRoleId, RUNTIME_ROOT_ROLE_ID } from "../roles.js";
import { normalizeRoleCapabilitySelectionProjection } from "./capability-selection-reconsideration.js";
import {
  isRoleOperationFingerprint,
  isRoleOperationOutcomeFingerprintForOutcome,
} from "./operation-supervision.js";
import {
  isReconsiderationCauseBoundToInvocationCount,
  normalizeRoleCapabilitySelectionReconsiderationCause,
} from "./reconsideration-cause.js";
import {
  isRoleCapabilityId,
  type RoleCallLedgerCommand,
  type RoleCapabilityBatchSettlement,
  type RoleCapabilityObservationBatchEntry,
} from "./contracts.js";
import { parseRoleCallPlanBinding } from "./plan.js";
import { normalizeRoleCallResultReceipt } from "./result-receipt.js";
import { decodeMemoryRecallCommand } from "./memory-recall-decoder.js";
import { parseRoleCallWorkerCapabilityScope } from "./worker-capability-scope.js";
import {
  isRoleCallWorkingDirectoryRoleId,
  normalizeEstablishedRoleCallWorkingDirectory,
  normalizeRoleCallWorkingDirectory,
} from "./working-directory.js";
import {
  exactKeys,
  isRecord,
  isRoleCapabilityDeclaredEffect,
  isRoleCapabilityObservedEffect,
  isUniqueStringArray,
  parseCapabilityResultReferences,
  parseOptionalCapabilityAdapterResult,
} from "./reducer-primitives.js";

export type DecodedRoleCallCommand =
  | Readonly<{ ok: true; value: RoleCallLedgerCommand }>
  | Readonly<{
      ok: false;
      code: "invalid_command" | "supervisor_child_forbidden";
    }>;

export function decodeRoleCallCommand(input: unknown): DecodedRoleCallCommand {
  if (!isRecord(input) || typeof input.type !== "string") {
    return { ok: false, code: "invalid_command" };
  }
  switch (input.type) {
    case "begin_memory_recall":
    case "settle_memory_recall":
      return decodeMemoryRecallCommand(input);
    case "create_root":
      return exactKeys(input, ["authority", "type"]) &&
        input.authority === "runtime"
        ? {
            ok: true,
            value: { authority: "runtime", type: "create_root" },
          }
        : { ok: false, code: "invalid_command" };
    case "complete_root_response":
      return exactKeys(input, ["authority", "type", "callId", "response"]) &&
        input.authority === "supervisor" &&
        typeof input.callId === "string" &&
        typeof input.response === "string"
        ? {
            ok: true,
            value: {
              authority: "supervisor",
              type: "complete_root_response",
              callId: input.callId,
              response: input.response,
            },
          }
        : { ok: false, code: "invalid_command" };
    case "open_child": {
      if (input.roleId === RUNTIME_ROOT_ROLE_ID) {
        return { ok: false, code: "supervisor_child_forbidden" };
      }
      const plannerPlan =
        input.plannerPlan === undefined
          ? undefined
          : parseRoleCallPlanBinding(input.plannerPlan);
      if (input.plannerPlan !== undefined && !plannerPlan) {
        return { ok: false, code: "invalid_command" };
      }
      const workerCapabilityScope =
        input.workerCapabilityScope === undefined
          ? undefined
          : parseRoleCallWorkerCapabilityScope(input.workerCapabilityScope);
      const workingDirectory = normalizeRoleCallWorkingDirectory(
        input.workingDirectory,
      );
      if (
        (input.workerCapabilityScope !== undefined && !workerCapabilityScope) ||
        (workerCapabilityScope && input.roleId !== "worker") ||
        (input.workingDirectory !== undefined && !workingDirectory) ||
        (workingDirectory !== undefined &&
          !isRoleCallWorkingDirectoryRoleId(input.roleId))
      ) {
        return { ok: false, code: "invalid_command" };
      }
      return exactKeys(
        input,
        ["authority", "type", "callerCallId", "roleId", "objective"],
        [
          "dependencyResultRefs",
          "plannerPlan",
          "workerCapabilityScope",
          "workingDirectory",
        ],
      ) &&
        input.authority === "active_role" &&
        typeof input.callerCallId === "string" &&
        isRuntimeDelegateRoleId(input.roleId) &&
        typeof input.objective === "string" &&
        (input.dependencyResultRefs === undefined ||
          isUniqueStringArray(input.dependencyResultRefs))
        ? {
            ok: true,
            value: {
              authority: "active_role",
              type: "open_child",
              callerCallId: input.callerCallId,
              roleId: input.roleId,
              objective: input.objective,
              ...(workerCapabilityScope ? { workerCapabilityScope } : {}),
              ...(workingDirectory !== undefined ? { workingDirectory } : {}),
              ...(input.dependencyResultRefs
                ? {
                    dependencyResultRefs: Object.freeze([
                      ...input.dependencyResultRefs,
                    ]),
                  }
                : {}),
              ...(plannerPlan ? { plannerPlan } : {}),
            },
          }
        : { ok: false, code: "invalid_command" };
    }
    case "return_child": {
      const receipt = normalizeRoleCallResultReceipt(input.receipt);
      return exactKeys(
        input,
        [
          "authority",
          "type",
          "callerCallId",
          "childCallId",
          "outcome",
          "summary",
        ],
        ["receipt"],
      ) &&
        input.authority === "runtime" &&
        typeof input.callerCallId === "string" &&
        typeof input.childCallId === "string" &&
        (input.outcome === "completed" || input.outcome === "failed") &&
        typeof input.summary === "string" &&
        receipt !== null
        ? {
            ok: true,
            value: {
              authority: "runtime",
              type: "return_child",
              callerCallId: input.callerCallId,
              childCallId: input.childCallId,
              outcome: input.outcome,
              summary: input.summary,
              ...(receipt ? { receipt } : {}),
            },
          }
        : { ok: false, code: "invalid_command" };
    }
    case "begin_capability_execution":
      return exactKeys(
        input,
        [
          "authority",
          "type",
          "callId",
          "invocationAttempt",
          "capabilityId",
          "declaredEffect",
          "intent",
          "controlsJson",
        ],
        ["actionFingerprint"],
      ) &&
        input.authority === "active_role" &&
        typeof input.callId === "string" &&
        Number.isInteger(input.invocationAttempt) &&
        typeof input.capabilityId === "string" &&
        isRoleCapabilityDeclaredEffect(input.declaredEffect) &&
        isEligibleActionFingerprintInput(input) &&
        typeof input.intent === "string" &&
        typeof input.controlsJson === "string"
        ? {
            ok: true,
            value: {
              authority: "active_role",
              type: "begin_capability_execution",
              callId: input.callId,
              invocationAttempt: input.invocationAttempt as number,
              capabilityId: input.capabilityId,
              declaredEffect: input.declaredEffect,
              intent: input.intent,
              controlsJson: input.controlsJson,
              ...(typeof input.actionFingerprint === "string"
                ? { actionFingerprint: input.actionFingerprint }
                : {}),
            },
          }
        : { ok: false, code: "invalid_command" };
    case "settle_capability_execution": {
      const references = parseCapabilityResultReferences(input.references);
      const exactResult = parseOptionalCapabilityAdapterResult(
        input.exactResult,
      );
      return exactKeys(
        input,
        [
          "authority",
          "type",
          "callId",
          "executionId",
          "outcome",
          "observedEffect",
          "summary",
          "exactResult",
        ],
        ["outcomeFingerprint", "referenceData", "references"],
      ) &&
        input.authority === "runtime" &&
        typeof input.callId === "string" &&
        typeof input.executionId === "string" &&
        (input.outcome === "succeeded" || input.outcome === "failed") &&
        (input.outcomeFingerprint === undefined ||
          isRoleOperationOutcomeFingerprintForOutcome(
            input.outcomeFingerprint,
            input.outcome,
          )) &&
        isRoleCapabilityObservedEffect(input.observedEffect) &&
        typeof input.summary === "string" &&
        (input.referenceData === undefined ||
          typeof input.referenceData === "string") &&
        references !== null &&
        exactResult !== null &&
        exactResult !== undefined
        ? {
            ok: true,
            value: {
              authority: "runtime",
              type: "settle_capability_execution",
              callId: input.callId,
              executionId: input.executionId,
              outcome: input.outcome,
              ...(typeof input.outcomeFingerprint === "string"
                ? { outcomeFingerprint: input.outcomeFingerprint }
                : {}),
              observedEffect: input.observedEffect,
              summary: input.summary,
              ...(typeof input.referenceData === "string"
                ? { referenceData: input.referenceData }
                : {}),
              ...(references ? { references } : {}),
              exactResult,
            },
          }
        : { ok: false, code: "invalid_command" };
    }
    case "begin_capability_batch": {
      const entries = parseObservationBatchEntries(input.entries);
      return exactKeys(input, [
        "authority",
        "type",
        "callId",
        "invocationAttempt",
        "entries",
      ]) &&
        input.authority === "active_role" &&
        typeof input.callId === "string" &&
        Number.isInteger(input.invocationAttempt) &&
        entries
        ? {
            ok: true,
            value: {
              authority: "active_role",
              type: "begin_capability_batch",
              callId: input.callId,
              invocationAttempt: input.invocationAttempt as number,
              entries,
            },
          }
        : { ok: false, code: "invalid_command" };
    }
    case "settle_capability_batch": {
      const settlements = parseCapabilityBatchSettlements(input.settlements);
      return exactKeys(input, ["authority", "type", "callId", "settlements"]) &&
        input.authority === "runtime" &&
        typeof input.callId === "string" &&
        settlements
        ? {
            ok: true,
            value: {
              authority: "runtime",
              type: "settle_capability_batch",
              callId: input.callId,
              settlements,
            },
          }
        : { ok: false, code: "invalid_command" };
    }
    case "update_capability_scope": {
      const scope = parseRoleCallWorkerCapabilityScope({
        catalogGroupIds: input.catalogGroupIds,
      });
      return exactKeys(input, [
        "authority",
        "type",
        "callId",
        "invocationAttempt",
        "mode",
        "catalogGroupIds",
      ]) &&
        input.authority === "active_role" &&
        typeof input.callId === "string" &&
        Number.isInteger(input.invocationAttempt) &&
        (input.mode === "open" || input.mode === "extend") &&
        scope
        ? {
            ok: true,
            value: {
              authority: "active_role",
              type: "update_capability_scope",
              callId: input.callId,
              invocationAttempt: input.invocationAttempt as number,
              mode: input.mode,
              catalogGroupIds: scope.catalogGroupIds,
            },
          }
        : { ok: false, code: "invalid_command" };
    }
    case "establish_working_directory": {
      const workingDirectory = normalizeEstablishedRoleCallWorkingDirectory(
        input.workingDirectory,
      );
      return exactKeys(input, [
        "authority",
        "type",
        "callId",
        "invocationAttempt",
        "workingDirectory",
      ]) &&
        input.authority === "active_role" &&
        typeof input.callId === "string" &&
        Number.isInteger(input.invocationAttempt) &&
        workingDirectory !== undefined
        ? {
            ok: true,
            value: {
              authority: "active_role",
              type: "establish_working_directory",
              callId: input.callId,
              invocationAttempt: input.invocationAttempt as number,
              workingDirectory,
            },
          }
        : { ok: false, code: "invalid_command" };
    }
    case "reconsider_capability_selection": {
      const selection = normalizeRoleCapabilitySelectionProjection(
        input.selection,
      );
      const cause = normalizeRoleCapabilitySelectionReconsiderationCause(
        input.cause,
      );
      return exactKeys(input, [
        "authority",
        "type",
        "callId",
        "invocationAttempt",
        "steeringVersion",
        "selection",
        "cause",
      ]) &&
        input.authority === "active_role" &&
        typeof input.callId === "string" &&
        Number.isInteger(input.invocationAttempt) &&
        Number.isSafeInteger(input.steeringVersion) &&
        (input.steeringVersion as number) >= 0 &&
        selection &&
        cause &&
        isReconsiderationCauseBoundToInvocationCount(
          cause,
          selection.invocations.length,
        )
        ? {
            ok: true,
            value: {
              authority: "active_role",
              type: "reconsider_capability_selection",
              callId: input.callId,
              invocationAttempt: input.invocationAttempt as number,
              steeringVersion: input.steeringVersion as number,
              selection,
              cause,
            },
          }
        : { ok: false, code: "invalid_command" };
    }
    default:
      return { ok: false, code: "invalid_command" };
  }
}

function isEligibleActionFingerprintInput(
  input: Record<string, unknown>,
): boolean {
  return (
    input.actionFingerprint === undefined ||
    isRoleOperationFingerprint(input.actionFingerprint)
  );
}

function parseObservationBatchEntries(
  input: unknown,
): readonly RoleCapabilityObservationBatchEntry[] | undefined {
  if (!Array.isArray(input) || input.length < 2) return undefined;
  const entries = input.map((entry) => {
    if (
      !isRecord(entry) ||
      !exactKeys(
        entry,
        ["capabilityId", "declaredEffect", "intent", "controlsJson"],
        ["actionFingerprint"],
      ) ||
      !isRoleCapabilityId(entry.capabilityId) ||
      entry.declaredEffect !== "observation" ||
      (entry.actionFingerprint !== undefined &&
        !isRoleOperationFingerprint(entry.actionFingerprint)) ||
      typeof entry.intent !== "string" ||
      typeof entry.controlsJson !== "string"
    ) {
      return undefined;
    }
    return Object.freeze({
      capabilityId: entry.capabilityId,
      declaredEffect: "observation" as const,
      intent: entry.intent,
      controlsJson: entry.controlsJson,
      ...(typeof entry.actionFingerprint === "string"
        ? { actionFingerprint: entry.actionFingerprint }
        : {}),
    });
  });
  return entries.some((entry) => entry === undefined)
    ? undefined
    : Object.freeze(entries as RoleCapabilityObservationBatchEntry[]);
}

function parseCapabilityBatchSettlements(
  input: unknown,
): readonly RoleCapabilityBatchSettlement[] | undefined {
  if (!Array.isArray(input) || input.length < 2) return undefined;
  const seen = new Set<string>();
  const settlements = input.map((entry) => {
    const exactResult = isRecord(entry)
      ? parseOptionalCapabilityAdapterResult(entry.exactResult)
      : null;
    if (
      !isRecord(entry) ||
      !exactKeys(
        entry,
        ["executionId", "outcome", "observedEffect", "summary", "exactResult"],
        ["outcomeFingerprint", "referenceData", "references"],
      ) ||
      typeof entry.executionId !== "string" ||
      entry.executionId.length === 0 ||
      seen.has(entry.executionId) ||
      (entry.outcome !== "succeeded" && entry.outcome !== "failed") ||
      (entry.outcomeFingerprint !== undefined &&
        !isRoleOperationOutcomeFingerprintForOutcome(
          entry.outcomeFingerprint,
          entry.outcome,
        )) ||
      !isRoleCapabilityObservedEffect(entry.observedEffect) ||
      typeof entry.summary !== "string" ||
      (entry.referenceData !== undefined &&
        typeof entry.referenceData !== "string") ||
      parseCapabilityResultReferences(entry.references) === null ||
      exactResult === null ||
      exactResult === undefined
    ) {
      return undefined;
    }
    seen.add(entry.executionId);
    const references = parseCapabilityResultReferences(entry.references);
    return Object.freeze({
      executionId: entry.executionId,
      outcome: entry.outcome,
      ...(typeof entry.outcomeFingerprint === "string"
        ? { outcomeFingerprint: entry.outcomeFingerprint }
        : {}),
      observedEffect: entry.observedEffect,
      summary: entry.summary,
      ...(typeof entry.referenceData === "string"
        ? { referenceData: entry.referenceData }
        : {}),
      ...(references ? { references } : {}),
      exactResult,
    });
  });
  return settlements.some((settlement) => settlement === undefined)
    ? undefined
    : Object.freeze(settlements as RoleCapabilityBatchSettlement[]);
}
