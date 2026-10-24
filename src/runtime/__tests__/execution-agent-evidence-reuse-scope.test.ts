import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { validateModelGatewayMessages } from "../../model-gateway/message-contract.js";
import { buildSemanticCompactionMessages } from "../context/semantic-compaction/generation-input.js";
import { SEMANTIC_COMPACTION_INSTRUCTIONS } from "../context/semantic-compaction/prompt.js";
import { EXECUTION_AGENT_COMPACTION_REQUIREMENTS } from "../context/semantic-compaction/execution-evidence-instructions.js";
import {
  buildExecutionAgentInput,
  buildExecutionAgentResponseInput,
  buildExecutionContinuationMessages,
} from "../steps/execution-agent/index.js";
import { EXECUTION_EVIDENCE_REUSE_INSTRUCTIONS } from "../steps/execution-agent/evidence-reuse-instructions.js";
import { buildSupervisorDecisionInput } from "../steps/supervisor-decision/input.js";
import {
  activeEvidenceCall,
  createControlsEvidenceFixture,
} from "./support/execution-controls-evidence-fixture.js";
import { semanticContractFixture } from "./support/semantic-compaction-contract-fixture.js";
import { createObservationControlsFixture, observationRefinementCall } from "./support/execution-observation-controls-fixture.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";

type EvidenceFixture = Awaited<ReturnType<typeof createControlsEvidenceFixture>>;

function decisionInput(fixture: EvidenceFixture) {
  const head = fixture.ledger.current();
  return buildExecutionAgentInput(fixture.request, {
    head,
    call: activeEvidenceCall(head),
    steeringSnapshot: fixture.steering.snapshot(),
    includeAcknowledgement: false,
    includeTitle: false,
    allowPlanner: true,
    allowAuditor: true,
  });
}

function policyOccurrences(messages: readonly ChatMessage[]): number {
  return messages.reduce(
    (count, message) =>
      count + message.content.split(EXECUTION_EVIDENCE_REUSE_INSTRUCTIONS).length - 1,
    0,
  );
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("execution evidence reuse instruction scope", () => {
  test("active capabilities receive one system policy without rewriting evidence or user intent", async () => {
    const fixture = await createControlsEvidenceFixture({
      prompt: "Change only the observed target; preserve its existing interface.",
    });
    const rawEvidence = "EXACT_SOURCE_BYTES\nexport const itemKey = 'stable-key';\n";
    const executionId = await fixture.addResult(rawEvidence);
    const head = fixture.ledger.current();
    const call = activeEvidenceCall(head);
    const canonical = buildExecutionContinuationMessages(head, call);
    const ledgerBefore = JSON.stringify(head);
    const input = decisionInput(fixture);

    expect(input.capabilities.length).toBeGreaterThan(0);
    expect(policyOccurrences(input.messages)).toBe(1);
    const policyMessages = input.messages.filter(({ content }) =>
      content.includes(EXECUTION_EVIDENCE_REUSE_INSTRUCTIONS),
    );
    expect(policyMessages).toHaveLength(1);
    expect(policyMessages[0]!.role).toBe("system");
    expect(
      input.messages.filter(({ role }) => role !== "system").some(({ content }) =>
        content.includes(EXECUTION_EVIDENCE_REUSE_INSTRUCTIONS),
      ),
    ).toBe(false);

    const toolEvidence = input.messages.filter(({ role }) => role === "tool");
    expect(toolEvidence).toEqual(canonical.filter(({ role }) => role === "tool"));
    const rawResult = toolEvidence.find(
      (message) => message.role === "tool" && message.toolCallId === executionId,
    );
    expect(rawResult).toBeDefined();
    expect(JSON.parse(rawResult!.content).result.adapterResult).toMatchObject({
      kind: "generic_capability_result_v1",
      payload: { referenceData: rawEvidence },
    });
    expect(input.messages.filter(({ toolCalls }) => toolCalls?.length))
      .toEqual(canonical.filter(({ toolCalls }) => toolCalls?.length));
    expect(input.messages.filter(({ content }) => content === fixture.request.prompt))
      .toEqual([{ role: "user", content: fixture.request.prompt }]);
    expect(() => validateModelGatewayMessages(input.messages)).not.toThrow();
    expect(decisionInput(fixture).messages).toEqual(input.messages);
    expect(JSON.stringify(fixture.ledger.current())).toBe(ledgerBefore);
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  test("response authoring preserves evidence without inheriting decision-only guidance", async () => {
    const fixture = await createControlsEvidenceFixture();
    await fixture.addResult("RESPONSE_SOURCE_BYTES");
    expect(policyOccurrences(decisionInput(fixture).messages)).toBe(1);

    const head = fixture.ledger.current();
    const call = activeEvidenceCall(head);
    const response = buildExecutionAgentResponseInput(fixture.request, {
      head,
      call,
      steeringSnapshot: fixture.steering.snapshot(),
    });

    expect(policyOccurrences(response.messages)).toBe(0);
    expect(response.messages.filter(({ role }) => role === "tool"))
      .toEqual(buildExecutionContinuationMessages(head, call).filter(({ role }) => role === "tool"));
    expect(response.messages.filter(({ content }) => content === fixture.request.prompt))
      .toEqual([{ role: "user", content: fixture.request.prompt }]);
    expect(() => validateModelGatewayMessages(response.messages)).not.toThrow();
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  test("before opening a capability scope the catalog does not imply an active offer", async () => {
    const fixture = createObservationControlsFixture();
    const { head, call } = await observationRefinementCall();
    const input = buildExecutionAgentInput(fixture.request, {
      head,
      call,
      steeringSnapshot: fixture.steering.snapshot(),
      includeAcknowledgement: false,
      includeTitle: false,
      allowPlanner: true,
      allowAuditor: true,
    });

    expect(call.workerCapabilityScope).toBeUndefined();
    expect(input.capabilityCatalogGroups.length).toBeGreaterThan(0);
    expect(input.capabilities).toEqual([]);
    expect(policyOccurrences(input.messages)).toBe(0);
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  test("exhausted capability allowance removes the policy while retaining settled evidence", async () => {
    const fixture = await createControlsEvidenceFixture({}, 1);
    expect(policyOccurrences(decisionInput(fixture).messages)).toBe(1);
    await fixture.addResult("LAST_ALLOWED_OBSERVATION");
    const head = fixture.ledger.current();
    expect(head.state.capabilityExecutions).toHaveLength(1);
    expect(head.policy.limits.maxCapabilityExecutions).toBe(1);

    const input = decisionInput(fixture);
    expect(input.capabilities).toEqual([]);
    expect(policyOccurrences(input.messages)).toBe(0);
    expect(input.messages.filter(({ role }) => role === "tool"))
      .toEqual(buildExecutionContinuationMessages(head, activeEvidenceCall(head))
        .filter(({ role }) => role === "tool"));
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  test("SUPER decision and SUPER-bound compactor keep their existing instruction scope", () => {
    const fixture = semanticContractFixture({ policy: "supervisor-worker-v1" });
    const decision = buildSupervisorDecisionInput(
      { ...fixture.params.request, historyMessages: [] },
      {
        toolResults: { sourceRevision: 0, results: [] },
        includeAcknowledgement: false,
        includeTitle: false,
      },
    );
    const compact = buildSemanticCompactionMessages({
      ...fixture.params,
      binding: {
        ...fixture.params.binding,
        roleId: "supervisor",
        allowedConsumers: ["supervisor.decision", "supervisor.response"],
      },
    });

    expect(policyOccurrences(decision.context.messages)).toBe(0);
    expect(policyOccurrences(compact)).toBe(0);
    expect(compact[0]).toEqual({
      role: "system",
      content: SEMANTIC_COMPACTION_INSTRUCTIONS,
    });
    for (const messages of [decision.context.messages, compact]) {
      expect(messages.some(({ content }) =>
        content.includes(EXECUTION_AGENT_COMPACTION_REQUIREMENTS),
      )).toBe(false);
    }
    expect(JSON.parse(compact[1]!.content).newSources[0].content)
      .toBe(fixture.source.content);
    expect(fixture.invoke).not.toHaveBeenCalled();
  });
});
