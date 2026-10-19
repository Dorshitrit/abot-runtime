import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type {
  RequestRunnerConfig,
  RequestStepInstructionBlock,
} from "../config/runner/contracts.js";
import { projectConfiguredStepMessages } from "../config/runner/step-instructions.js";
import { CONVERSATION_MEMORY_AUTHORING_INSTRUCTIONS } from "../long-term-memory/conversation-authoring/prompt.js";
import { EXECUTION_AGENT_DIRECT_RESPONSE_MAX_LENGTH } from "../steps/execution-agent/direct-response-contract.js";
import { buildDirectResponseInstructions } from "../steps/execution-agent/direct-response-prompt.js";

function methodology(ref: string, content: string): RequestStepInstructionBlock {
  return { ref, content, contentHash: createHash("sha256").update(content).digest("hex") };
}

function methodologyConfig(
  decision: readonly RequestStepInstructionBlock[] = [],
  response: readonly RequestStepInstructionBlock[] = [],
): RequestRunnerConfig {
  return {
    models: { defaults: { profileId: "assembly-test", steps: {} } },
    context: { outputReserveTokens: 1_000, safetyReserveTokens: 100, attachmentReserveTokens: 0 },
    steps: {
      "execution.decision": { timeoutMs: 20_000, instructionBlocks: decision },
      "execution.response": { timeoutMs: 20_000, instructionBlocks: response },
    },
  };
}

test("custom response methodologies retain exact content and order while cross-step duplicates appear once", () => {
  const shared = methodology("shared.md", "# Shared convention\n\nPreserve this `source` exactly.");
  const first = methodology("first.md", "# First presentation\n\nFirst line.\n\n- Preserve punctuation: [] | :");
  const second = methodology("second.md", "# Second presentation\n\nFinal custom block.");
  const config = methodologyConfig([shared], [
    first,
    methodology("shared-alias.md", shared.content),
    second,
    methodology("first-alias.md", first.content),
  ]);
  const instructions = buildDirectResponseInstructions(
    EXECUTION_AGENT_DIRECT_RESPONSE_MAX_LENGTH,
    config,
  ).join("\n");
  const projected = projectConfiguredStepMessages({
    runnerConfig: config,
    modelStep: "execution.decision",
    messages: [{ role: "system", content: instructions }],
  });
  const content = projected.messages[0]!.content;

  expect(instructions).not.toContain(shared.content);
  for (const block of [shared, first, second])
    expect(content.split(block.content)).toHaveLength(2);
  expect(content.indexOf(first.content)).toBeLessThan(content.indexOf(second.content));
  expect(projected.contentHashes).toEqual([shared.contentHash]);
});

test.each([false, true])("direct-only instructions are absent when direct response is unavailable, memory=%s", memoryEnabled => {
  const custom = methodology("response.md", "# Deferred presentation\n\nUser-defined guidance.");
  expect(buildDirectResponseInstructions(
    undefined,
    methodologyConfig([], [custom]),
    memoryEnabled,
  )).toEqual([]);
});

test.each([false, true])("direct response includes the canonical shared memory policy only when enabled, memory=%s", memoryEnabled => {
  const custom = methodology("response.md", "# Response layout\n\nKeep this custom convention.");
  const instructions = buildDirectResponseInstructions(
    EXECUTION_AGENT_DIRECT_RESPONSE_MAX_LENGTH,
    methodologyConfig([], [custom]),
    memoryEnabled,
  ).join("\n");
  const memoryPolicy = CONVERSATION_MEMORY_AUTHORING_INSTRUCTIONS.join("\n\n");

  expect(instructions.split(custom.content)).toHaveLength(2);
  expect(instructions.includes(memoryPolicy)).toBe(memoryEnabled);
  if (memoryEnabled)
    expect(instructions.split(memoryPolicy)).toHaveLength(2);
});
