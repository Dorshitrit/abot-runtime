import type { SemanticCompactionContinuation } from "../semantic-compaction/contracts.js";

/** Present the RAW handoff honestly while preserving older structured checkpoint facts. */
export function projectSuperContinuation(
  continuation: SemanticCompactionContinuation,
) {
  const sections: ReadonlyArray<readonly [string, string | readonly string[]]> =
    [
      ["Current state", continuation.currentState],
      ["Completed", continuation.completed],
      ["Findings", continuation.findings],
      ["Evidence references", continuation.evidenceRefs],
      ["Artifacts", continuation.artifacts],
      ["Decisions", continuation.decisions],
      ["Failed approaches", continuation.failedApproaches],
      ["Open work", continuation.openWork],
      ["Blockers", continuation.blockers],
      ["Next step", continuation.nextStep],
    ];
  const populatedSections = sections.flatMap(([label, value]) => {
    const text =
      typeof value === "string"
        ? value
        : value.map((entry) => `- ${entry}`).join("\n");
    if (!hasRecordedContinuationSection(text)) return [];
    return [`${label}:\n${text}`];
  });
  return Object.freeze({
    kind: "runtime_super_raw_handoff_v1",
    authority: "derived_passive_continuity",
    presenceEffect: "no_new_intent_routing_or_completion",
    omissionMeaning: "omitted_sections_are_not_assertions_of_absence",
    text: populatedSections.join("\n\n"),
  });
}

function hasRecordedContinuationSection(text: string): boolean {
  return text.trim().length > 0;
}
