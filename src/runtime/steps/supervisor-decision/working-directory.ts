import type {
  ChatMessage,
  ModelGatewayJsonSchemaFormat,
} from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import {
  normalizeRoleCallWorkingDirectory,
  ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
} from "../../orchestration/role-calls/index.js";
import {
  SUPERVISOR_DECISION_MODEL_STEP,
  type SupervisorDecision,
  type SupervisorDecisionDiagnosticContext,
  type SupervisorDecisionValidationIssue,
  type SupervisorWorkingDirectoryDecision,
  type SupervisorWorkingDirectoryParseResult,
  type SupervisorWorkingDirectoryRoutingDecision,
} from "./contracts.js";
import {
  traceSupervisorWorkingDirectoryContextProjected,
  traceSupervisorWorkingDirectoryOutputAccepted,
  traceSupervisorWorkingDirectoryOutputRejected,
} from "./diagnostics.js";
import { buildSupervisorWorkingDirectoryInstructions } from "./prompt.js";

export const SUPERVISOR_FROZEN_INVOCATION_KIND =
  "runtime_supervisor_frozen_invocation_v1" as const;

export function createSupervisorWorkingDirectoryFormat(): ModelGatewayJsonSchemaFormat {
  return {
    type: "json_schema",
    name: "supervisor_working_directory",
    strict: true,
    postValidatedSchemaConstraints: Object.freeze([
      Object.freeze({
        keyword: "maxLength" as const,
        path: "/properties/workingDirectory/maxLength",
      }),
    ]),
    schema: {
      type: "object",
      properties: {
        workingDirectory: {
          type: "string",
          minLength: 1,
          maxLength: ROLE_CALL_WORKING_DIRECTORY_MAX_LENGTH,
          description:
            "The narrowest exact existing or new project directory relative to the configured agent work root; use '.' only when no narrower project directory owns the frozen outcome.",
        },
      },
      required: ["workingDirectory"],
      additionalProperties: false,
    },
  };
}

export function buildSupervisorWorkingDirectoryInput(
  sourceContext: RequestContextProjection,
  options: Readonly<{
    frozenDecision: SupervisorWorkingDirectoryRoutingDecision;
    diagnostic?: SupervisorDecisionDiagnosticContext;
  }>,
): Readonly<{
  messages: ChatMessage[];
  format: ModelGatewayJsonSchemaFormat;
  modelStep: typeof SUPERVISOR_DECISION_MODEL_STEP;
}> {
  const [sourceInstructions, ...sourceMessages] = sourceContext.messages;
  if (sourceInstructions?.role !== "system") {
    throw new Error("supervisor_working_directory_source_context_invalid");
  }
  const diagnostic = options.diagnostic
    ? Object.freeze({
        ...options.diagnostic,
        decisionPhase: "working_directory" as const,
      })
    : undefined;
  const format = createSupervisorWorkingDirectoryFormat();
  const messages: ChatMessage[] = [
    Object.freeze({
      role: "system" as const,
      content: buildSupervisorWorkingDirectoryInstructions(),
    }),
    ...sourceMessages,
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify({
        kind: SUPERVISOR_FROZEN_INVOCATION_KIND,
        authority: "canonical_runtime_state",
        roleId: options.frozenDecision.roleId,
        objective: options.frozenDecision.objective,
      }),
    }),
  ];

  if (diagnostic) {
    traceSupervisorWorkingDirectoryContextProjected({
      diagnostic,
      sourceContext,
      messages,
      format,
      frozenDecision: options.frozenDecision,
    });
  }

  return Object.freeze({
    messages,
    format,
    modelStep: SUPERVISOR_DECISION_MODEL_STEP,
  });
}

export function parseSupervisorWorkingDirectoryOutput(
  text: string,
  options: Readonly<{
    diagnostic?: SupervisorDecisionDiagnosticContext;
  }> = {},
): SupervisorWorkingDirectoryParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text.trim()) as unknown;
  } catch {
    return rejectWorkingDirectoryOutput({
      diagnostic: options.diagnostic,
      outputLength: text.length,
      stage: "json_envelope",
      issues: [
        issue(
          "supervisor_working_directory_output_not_json",
          "workingDirectory",
          "Expected one JSON object containing only workingDirectory.",
        ),
      ],
    });
  }
  const record = asRecord(decoded);
  if (!record) {
    return rejectWorkingDirectoryOutput({
      diagnostic: options.diagnostic,
      outputLength: text.length,
      stage: "json_envelope",
      issues: [
        issue(
          "supervisor_working_directory_output_not_object",
          "workingDirectory",
          "Expected one JSON object containing only workingDirectory.",
        ),
      ],
    });
  }
  if (
    Object.keys(record).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(record, "workingDirectory")
  ) {
    return rejectWorkingDirectoryOutput({
      diagnostic: options.diagnostic,
      outputLength: text.length,
      stage: "json_envelope",
      issues: [
        issue(
          "supervisor_working_directory_shape_invalid",
          "workingDirectory",
          "Return exactly one workingDirectory field.",
        ),
      ],
    });
  }

  const workingDirectory = normalizeRoleCallWorkingDirectory(
    record.workingDirectory,
  );
  if (!workingDirectory) {
    return rejectWorkingDirectoryOutput({
      diagnostic: options.diagnostic,
      outputLength: text.length,
      stage: "domain_parser",
      issues: [
        issue(
          "supervisor_working_directory_invalid",
          "workingDirectory",
          "workingDirectory must be a bounded project directory relative to the configured agent work root.",
        ),
      ],
    });
  }

  const decision: SupervisorWorkingDirectoryDecision = Object.freeze({
    workingDirectory,
  });
  if (options.diagnostic) {
    traceSupervisorWorkingDirectoryOutputAccepted({
      diagnostic: options.diagnostic,
      outputLength: text.length,
      workingDirectoryLength: workingDirectory.length,
    });
  }
  return Object.freeze({ ok: true as const, decision });
}

export function mergeSupervisorWorkingDirectory(
  frozenDecision: SupervisorWorkingDirectoryRoutingDecision,
  scope: SupervisorWorkingDirectoryDecision,
): SupervisorDecision {
  const merged = {
    ...frozenDecision,
    workingDirectory: scope.workingDirectory,
  } as SupervisorDecision;
  return deepFreeze(structuredClone(merged));
}

function rejectWorkingDirectoryOutput(params: {
  diagnostic?: SupervisorDecisionDiagnosticContext;
  outputLength: number;
  stage: "json_envelope" | "domain_parser";
  issues: readonly SupervisorDecisionValidationIssue[];
}): SupervisorWorkingDirectoryParseResult {
  if (params.diagnostic) {
    traceSupervisorWorkingDirectoryOutputRejected({
      diagnostic: params.diagnostic,
      outputLength: params.outputLength,
      validationStage: params.stage,
      issues: params.issues,
    });
  }
  return Object.freeze({
    ok: false as const,
    stage: params.stage,
    issues: Object.freeze([...params.issues]),
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function issue(
  code: string,
  path: string,
  message: string,
): SupervisorDecisionValidationIssue {
  return Object.freeze({ code, path, message });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
