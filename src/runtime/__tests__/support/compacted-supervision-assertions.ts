import { expect } from "vitest";
import type { ChatMessage } from "../../../model-gateway/types.js";

type CompactedReference = {
  kind: string;
  scopeId: string;
  sourceRef: string;
  sourceFingerprint: string;
};

export function expectCompactedSupervisionReference(
  messages: readonly ChatMessage[],
  evidence: CompactedReference,
  expectedSourceRef: string,
  expectedDigest?: string,
) {
  expect(evidence.kind).toBe("compacted_capability_result_reference");
  expect(evidence.sourceRef).toBe(expectedSourceRef);
  expect(evidence).not.toHaveProperty("adapterResult");
  const checkpoints = messages.flatMap(({ content }) => {
    try {
      const value = JSON.parse(content);
      if (value.kind === "runtime_semantic_compaction_checkpoint_v2")
        return [value];
      if (
        value.kind === "runtime_request_tool_results_v1" &&
        value.semanticCheckpoint
      )
        return [value.semanticCheckpoint];
    } catch {
      /* ordinary text */
    }
    return [];
  });
  const sources = checkpoints
    .filter(({ scopeId }) => scopeId === evidence.scopeId)
    .flatMap(({ coveredSources }) => coveredSources)
    .filter(
      (source: { sourceRef: string }) =>
        source.sourceRef === evidence.sourceRef,
    );
  expect(sources).toHaveLength(1);
  expect(sources[0].sourceFingerprint).toBe(evidence.sourceFingerprint);
  if (expectedDigest !== undefined)
    expect(sources[0].digest).toContain(expectedDigest);
}
