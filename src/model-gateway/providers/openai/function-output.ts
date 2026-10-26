import { resolveModelInvocationStep } from "../../../shared/model-step-registry.js";
import {
  isModelGatewayJsonSchemaFormat,
  isPlainObject,
} from "../../structured-output/format-contract.js";
import type { ModelGatewayJsonSchemaFormat } from "../../types.js";

type OpenAIFunctionOutput = Readonly<{
  tools: readonly Record<string, unknown>[];
  tool_choice: Readonly<{ type: "function"; name: string }>;
  parallel_tool_calls: false;
}>;

function hasNativeFunctionOutputContract(modelStep: unknown): boolean {
  const contract = resolveModelInvocationStep(modelStep)?.outputContract;
  if (contract === "capability_controls") return true;
  if (contract === "execution_agent_decision") return true;
  return contract === "context_compaction";
}

function hasFunctionParametersSchema(
  format: unknown,
): format is ModelGatewayJsonSchemaFormat {
  if (!isModelGatewayJsonSchemaFormat(format)) return false;
  return format.schema.type === "object";
}

// Transport the existing structured envelope as one function's arguments.
// The Runtime still owns validation, canonical state and execution authority.
export function projectOpenAIFunctionOutput(
  modelStep: unknown,
  format: unknown,
): OpenAIFunctionOutput | undefined {
  if (!hasNativeFunctionOutputContract(modelStep)) return undefined;
  if (!hasFunctionParametersSchema(format)) return undefined;
  return {
    tools: [{
      type: "function",
      name: format.name,
      parameters: format.schema,
      ...(format.description === undefined ? {} : { description: format.description }),
      ...(format.strict === undefined ? {} : { strict: format.strict }),
    }],
    tool_choice: { type: "function", name: format.name },
    parallel_tool_calls: false,
  };
}

export function resolveOpenAIFunctionOutputName(
  payload: Record<string, unknown>,
): string | undefined {
  const choice = payload.tool_choice;
  if (!isPlainObject(choice)) return undefined;
  if (choice.type !== "function") return undefined;
  return typeof choice.name === "string" ? choice.name : undefined;
}
