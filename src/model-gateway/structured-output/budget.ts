import { estimateAsciiCharacterTokens } from "../../runtime/context/token-estimator.js";
import type {
  ModelGatewayFormat,
  ModelTokenEstimationConfig,
} from "../types.js";
import { isModelGatewayJsonSchemaFormat } from "./format-contract.js";
import { estimateStrictSchemaCharacters } from "./schema-character-estimator.js";

const JSON_TERMINATION_TOKEN_RESERVE = 1;

/**
 * Estimates the generation allowance for the largest bounded JSON shape using
 * the selected profile's token estimator. Undefined means at least one output
 * shape has no finite schema bound, so the provider must use physical capacity.
 */
export function estimateStrictStructuredOutputTokenCeiling(
  format: ModelGatewayFormat | undefined,
  tokenEstimation?: ModelTokenEstimationConfig,
): number | undefined {
  if (!isModelGatewayJsonSchemaFormat(format) || format.strict !== true) {
    return undefined;
  }
  const maximumCharacters = estimateStrictSchemaCharacters(format.schema);
  if (maximumCharacters === undefined) {
    return undefined;
  }
  return Math.max(
    1,
    estimateAsciiCharacterTokens(maximumCharacters, tokenEstimation) +
      JSON_TERMINATION_TOKEN_RESERVE,
  );
}
