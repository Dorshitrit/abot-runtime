import type { SemanticCompactionSourceIdentity } from "./contracts.js";

/** Invocation-local keys never replace canonical source identity or ordering. */
export function bindSemanticCompactionSourceSlots<
  Source extends SemanticCompactionSourceIdentity,
>(
  sources: readonly Source[],
  offset = 0,
): readonly (Source & { readonly sourceKey: string })[] {
  return Object.freeze(
    sources.map((source, index) =>
      Object.freeze({ ...source, sourceKey: `source_${offset + index}` }),
    ),
  );
}
