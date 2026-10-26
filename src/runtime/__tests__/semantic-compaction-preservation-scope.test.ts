import { expect, test } from "vitest";
import type { ModelStep } from "../../shared/model-steps.js";
import { generateSemanticCompactionCandidateBatched } from "../context/semantic-compaction/index.js";
import {
  EXECUTION_AGENT_COMPACTION_REQUIREMENTS,
  resolveSemanticCompactionInstructions,
} from "../context/semantic-compaction/execution-evidence-instructions.js";
import { SEMANTIC_COMPACTION_INSTRUCTIONS, EXECUTION_SEMANTIC_COMPACTION_INSTRUCTIONS } from "../context/semantic-compaction/prompt.js";
import {
  COMPACTION_FACT,
  compactContinuation,
  readCompactionEnvelope,
  semanticContractFixture,
} from "./support/semantic-compaction-contract-fixture.js";
import { semanticCompactionReplacementSlots } from "./support/semantic-compaction-replacement-fixture.js";

const scopeCases: ReadonlyArray<{
  consumers: readonly ModelStep[];
  executionAgentOnly: boolean;
}> = [
  { consumers: ["execution.decision"], executionAgentOnly: true },
  { consumers: ["execution.response"], executionAgentOnly: true },
  { consumers: ["execution.decision", "execution.response"], executionAgentOnly: true },
  { consumers: ["supervisor.decision", "supervisor.response"], executionAgentOnly: false },
  { consumers: ["worker.decision"], executionAgentOnly: false },
  { consumers: ["tool_payload.raw"], executionAgentOnly: false },
  { consumers: ["capability.controls"], executionAgentOnly: false },
  { consumers: ["execution.decision", "worker.decision"], executionAgentOnly: false },
  { consumers: [], executionAgentOnly: false },
];

test.each(scopeCases)(
  "preservation requirements follow the complete bound consumer family: $consumers",
  ({ consumers, executionAgentOnly }) => {
    const instructions = resolveSemanticCompactionInstructions(consumers);
    const expected = executionAgentOnly
      ? [EXECUTION_SEMANTIC_COMPACTION_INSTRUCTIONS, EXECUTION_AGENT_COMPACTION_REQUIREMENTS].join("\n")
      : SEMANTIC_COMPACTION_INSTRUCTIONS;
    // Assert assembly identity and scope, never a snapshot of instruction prose.
    expect(instructions).toBe(expected);
  },
);

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  test.each([false, true])(
    `${policy} preserves the instruction scope through normal/sliced input and repair (sliced=%s)`,
    async (sliced) => {
      const fixture = semanticContractFixture({
        policy,
        sliced,
        output(attempt, messages) {
          if (attempt === 1) return "invalid JSON";
          return JSON.stringify({
            continuation: compactContinuation(),
            sourceDigests: semanticCompactionReplacementSlots(
              readCompactionEnvelope(messages),
              () => COMPACTION_FACT,
            ),
          });
        },
      });
      const candidate = await generateSemanticCompactionCandidateBatched(fixture.params);
      expect(fixture.captured.length).toBeGreaterThan(1);
      const expectedInstructions = resolveSemanticCompactionInstructions(
        fixture.params.binding.allowedConsumers,
      );
      for (const messages of fixture.captured) {
        const system = messages.filter(({ role }) => role === "system");
        expect(system.some(({ content }) => content.startsWith(expectedInstructions))).toBe(true);
        expect(system.some(({ content }) => content.includes(EXECUTION_AGENT_COMPACTION_REQUIREMENTS)))
          .toBe(policy === "execution-agent-v1");
      }
      const envelopes = fixture.captured.map(readCompactionEnvelope);
      expect(envelopes[1]).toEqual(envelopes[0]);
      expect(candidate.sourceDigests.map(({ sourceRef, sourceFingerprint }) => ({ sourceRef, sourceFingerprint })))
        .toEqual([{ sourceRef: fixture.source.sourceRef, sourceFingerprint: fixture.source.sourceFingerprint }]);
      expect(fixture.store.get(fixture.params.scopeId)).toBeUndefined();
      if (sliced) {
        expect(envelopes.every(({ sourceSlice }) => sourceSlice !== undefined)).toBe(true);
        return;
      }
      expect(envelopes.every(({ newSources }) => newSources?.[0]?.content === fixture.source.content)).toBe(true);
    },
  );
}
