import type { TestRequestSeed } from "./request-execution-scope.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { projectRequestToolResults } from "../../context/request-tool-results.js";
import { runExecutionAgentDecision } from "../../steps/execution-agent/run.js";
import { runExecutionAgentResponse } from "../../steps/execution-agent/response-run.js";
import {
  activeEvidenceCall,
  createControlsEvidenceFixture,
} from "./execution-controls-evidence-fixture.js";
import {
  compactContinuation,
  readCompactionEnvelope,
} from "./semantic-compaction-contract-fixture.js";
import { semanticCompactionReplacementSlots } from "./semantic-compaction-replacement-fixture.js";

export const STEERED_FACT = "The selected target has verified value 42.";
export const STEERED_CONTINUATION = "OLD_OBJECTIVE_CONTINUATION_DO_NOT_INHERIT";
export const STEERED_RAW = "UNCOMPACTED_EVIDENCE_".repeat(600);

export async function executionCompactionSteeringFixture(
  overrides: Partial<TestRequestSeed> = {},
) {
  const fixture = await createControlsEvidenceFixture(overrides);
  const executionId = await fixture.addResult(STEERED_RAW);
  fixture.countInputTokens.mockImplementation(async (input) => {
    const mainEaConsumer = input.modelStep === "execution.decision" || input.modelStep === "execution.response";
    const pressuredInputTokens = mainEaConsumer ? 29_000 : 24_000;
    return {
      inputTokens:
        input.modelStep !== "context.compact" &&
        ((input.messages as readonly ChatMessage[]).some(
          ({ role }) => role === "tool",
        ) || JSON.stringify(input.messages).includes("UNCOMPACTED_EVIDENCE_"))
          ? pressuredInputTokens
          : 1000,
      profileId: "test",
      provider: "openai",
      model: "test",
      contextWindowTokens: 32000,
      source: "provider_input_token_count",
    };
  });
  fixture.invoke.mockImplementation(async (input) => {
    if (input.modelStep !== "context.compact")
      return {
        text:
          input.modelStep === "execution.response"
            ? "The requested result."
            : JSON.stringify({ decision: { action: "respond" } }),
        meta: {},
      };
    const envelope = readCompactionEnvelope(
      input.messages as readonly ChatMessage[],
    );
    return {
      text: JSON.stringify({
        continuation: compactContinuation({
          currentState: STEERED_CONTINUATION,
          decisions: [STEERED_CONTINUATION],
          openWork: [STEERED_CONTINUATION],
          blockers: [STEERED_CONTINUATION],
          nextStep: STEERED_CONTINUATION,
        }),
        sourceDigests: semanticCompactionReplacementSlots(
          envelope,
          () => STEERED_FACT,
        ),
      }),
      meta: {},
    };
  });
  const options = () => ({
    head: fixture.ledger.current(),
    call: activeEvidenceCall(fixture.ledger.current()),
    steeringSnapshot: fixture.steering.snapshot(),
    includeAcknowledgement: false,
    includeTitle: false,
    allowPlanner: true,
    allowAuditor: true,
  });
  const view = () =>
    projectRequestToolResults({
      ledger: fixture.ledger,
      head: fixture.ledger.current(),
      callId: "call-1",
      modelStep: "execution.decision",
    });
  const run = (response = false, frozen = options()) =>
    response
      ? runExecutionAgentResponse(fixture.request, frozen)
      : runExecutionAgentDecision(fixture.request, frozen);
  return { ...fixture, executionId, options, view, run };
}
