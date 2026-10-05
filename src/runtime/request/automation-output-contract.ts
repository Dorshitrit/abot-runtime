import type { ModelGatewayJsonSchemaFormat } from "../../model-gateway/types.js";
import type { ToolNormalInvocationInput } from "../../capabilities/normal-invocation/contracts.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import type { RawModelValidationResult } from "../model/invoke-raw-step.js";

/** Request-local, trusted terminal output contract; absent for ordinary chat. */
export function automationResponseFormat(
  schema: ToolNormalInvocationInput | undefined,
): ModelGatewayJsonSchemaFormat | undefined {
  if (!schema) return undefined;
  return {
    type: "json_schema",
    name: "automation_step_result",
    strict: true,
    schema,
  };
}

export function validateAutomationResponse(
  schema: ToolNormalInvocationInput,
  text: string,
): RawModelValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid("automation_agent_output_invalid_json", "Return one JSON object only.");
  }
  const issue = validateJsonSchemaValue(schema as Readonly<Record<string, unknown>>, parsed);
  if (issue) return invalid("automation_agent_output_invalid_schema", issue.message);
  return { ok: true, value: text };
}

function invalid(code: string, message: string): RawModelValidationResult {
  return {
    ok: false,
    stage: "response_contract",
    issues: [{ code, path: "output", message }],
    reason: code,
  };
}
