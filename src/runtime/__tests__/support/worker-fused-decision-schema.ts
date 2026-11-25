import type { ModelGatewayFormat } from "../../../model-gateway/types.js";

type Schema = {
  anyOf?: readonly Schema[];
  properties?: Record<string, Schema>;
};

/** Read each allowed selection through the fused assessment/selection envelope. */
export function workerFusedSelectionSchemas(format: ModelGatewayFormat | undefined): readonly Schema[] {
  if (typeof format !== "object" || format.name !== "worker_evidence_and_selection")
    throw new Error("fixture_worker_fused_format_missing");
  const alternatives = (format.schema as Schema).properties?.decision?.anyOf;
  if (!alternatives) throw new Error("fixture_worker_fused_variants_missing");
  return alternatives.flatMap((variant) => {
    const selection = variant.properties?.selection;
    if (!selection) throw new Error("fixture_worker_fused_selection_missing");
    return selection.anyOf ?? [selection];
  });
}
