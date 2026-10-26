import { semanticCompactionReplacementSlots } from "./support/semantic-compaction-replacement-fixture.js";
import { readCompactionEnvelope } from "./support/semantic-compaction-contract-fixture.js";
import { afterEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { createAutomationAgentAssignment } from "../automations/agent-assignment.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import {
  addAgent,
  operation,
  probeTools,
  scriptToolUsingAgent,
} from "./support/automation-agent-tool-fixture.js";

type Fixture = Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>;
type CompactionInput = ReturnType<typeof readCompactionEnvelope> & Readonly<{
  currentRequest: string;
}>;

const fixtures: Fixture[] = [];
const sourceFact = "The selected source confirms observation 42.";
const sourceBody = `${"Uncompacted source detail. ".repeat(4_000)}\n${sourceFact}`;
const boundInputs = {
  sourceLabel: "The explicitly bound automation evidence.",
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

function compactedOutput(input: CompactionInput) {
  const sourceRefs =
    input.newSources?.map((source) => source.sourceRef) ??
    (input.sourceSlice ? [input.sourceSlice.sourceRef] : []);
  expect(sourceRefs.length).toBeGreaterThan(0);
  return JSON.stringify({
    continuation: {
      completed: ["Observed the selected source."],
      currentState: "The source is available.",
      findings: [sourceFact],
      evidenceRefs: sourceRefs,
      artifacts: [],
      decisions: [],
      failedApproaches: [],
      openWork: ["Return the requested result."],
      blockers: [],
      nextStep: "Return the grounded result under the original assignment.",
    },
    sourceDigests: semanticCompactionReplacementSlots(input, () => sourceFact),
  });
}

function assignmentMessages(messages: readonly ChatMessage[]) {
  return messages.filter(
    (message) =>
      message.role === "user" &&
      message.content.includes("automation_node_assignment_v2"),
  );
}

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s compacts accumulated tool evidence and resumes the intact automation assignment",
  async (policy) => {
    const phases: string[] = [];
    const compactInputs: CompactionInput[] = [];
    const superCompactInputs: Array<{ currentRequest: string }> = [];
    const tools = probeTools();
    tools.execute.mockImplementation(async (call) => {
      phases.push("tool.settled");
      return {
        ok: true,
        tool: call.tool,
        output: sourceBody,
        producedNewInformation: true,
      };
    });
    const fixture = await createSchedulerRuntimeFixture(
      policy,
      undefined,
      tools.registry,
    );
    fixtures.push(fixture);
    scriptToolUsingAgent(fixture, policy);
    const scriptedInvoke = fixture.invoke.getMockImplementation()!;
    fixture.invoke.mockImplementation(async (input) => {
      phases.push(input.modelStep!);
      const returnsEvidence =
        input.modelStep === "worker.result" ||
        input.modelStep === "execution.response" ||
        input.modelStep === "supervisor.response";
      if (returnsEvidence) {
        expect(JSON.stringify(input.messages)).toContain(sourceFact);
        return { text: sourceFact, meta: {} };
      }
      const isSuperCompactionStage = policy === "supervisor-worker-v1" &&
        input.modelStep?.startsWith("super.compact.");
      if (isSuperCompactionStage) {
        const messages = input.messages as readonly ChatMessage[];
        const envelope = JSON.parse(messages.find(({ role }) => role === "user")!.content);
        expect(envelope.kind).toBe("runtime_super_compaction_stage_input_v1");
        superCompactInputs.push(envelope.baseCapsule);
        return { text: sourceFact, meta: {} };
      }
      if (input.modelStep !== "context.compact") return scriptedInvoke(input);
      const messages = input.messages as readonly ChatMessage[];
      const compactInput = readCompactionEnvelope(messages) as CompactionInput;
      compactInputs.push(compactInput);
      return { text: compactedOutput(compactInput), meta: {} };
    });

    const studio = fixture.application.services.automations!;
    let draft = await studio.create("Compacted source evidence");
    draft = await addAgent(studio, draft, "Observe and report");
    if (policy === "supervisor-worker-v1") {
      // This large-source fixture exercises several RAW windows and merge stages.
      draft = await studio.updateDraft(draft.automationId, draft.revision, {
        kind: "update_definition",
        patch: { limits: { ...draft.definition.limits, maxModelCallsPerRun: 128 } },
      });
    }
    const nodeId = draft.definition.body.children[0]!.id;
    draft = await studio.updateDraft(draft.automationId, draft.revision, {
      kind: "update_node",
      nodeId,
      patch: {
        inputs: {
          sourceLabel: { kind: "literal", value: boundInputs.sourceLabel },
        },
      },
    });
    const node = draft.definition.body.children[0]!;
    if (node.kind !== "agent") throw new Error("expected_agent_fixture");
    const expectedAssignment = createAutomationAgentAssignment({
      definition: draft.definition,
      node,
      inputs: boundInputs,
    });
    await studio.replaceGrant({
      automationId: draft.automationId,
      expectedGrantRevision: 0,
      mode: "full_access",
      operations: [operation],
      actionId: "test-grant",
    });
    await studio.publish(draft.automationId, draft.revision);
    const started = await studio.runNow(draft.automationId);
    await expect
      .poll(async () => (await studio.getRun(started.id)).status, {
        timeout: 10_000,
        interval: 10,
      })
      .toMatch(/^(succeeded|failed)$/u);
    const run = await studio.getRun(started.id);
    expect(run.status, JSON.stringify(run.report?.nodeResults)).toBe(
      "succeeded",
    );
    expect(run.report).toMatchObject({
      toolCalls: 1,
      effectSummary: { verifiedExecutions: 1 },
    });
    expect(tools.execute).toHaveBeenCalledOnce();
    expect(fixture.invokeRaw).not.toHaveBeenCalled();

    const observedCompactionInputs = policy === "execution-agent-v1"
      ? compactInputs : superCompactInputs;
    const firstCompactionStep = policy === "execution-agent-v1"
      ? "context.compact" : "super.compact.coverage";
    expect(observedCompactionInputs.length).toBeGreaterThan(0);
    expect(phases.indexOf(firstCompactionStep)).toBeGreaterThan(
      phases.indexOf("tool.settled"),
    );
    expect(
      observedCompactionInputs.some((input) => JSON.stringify(input).includes(sourceFact)),
    ).toBe(true);
    for (const input of observedCompactionInputs)
      expect(input.currentRequest).toBe(expectedAssignment);
    if (policy === "supervisor-worker-v1")
      expect(compactInputs).toHaveLength(0);

    const prefix = policy === "execution-agent-v1" ? "execution" : "supervisor";
    const modelCalls = fixture.invoke.mock.calls.map(([call]) => call);
    const rootCalls = modelCalls.filter(
      (call) =>
        call.modelStep === `${prefix}.decision` ||
        call.modelStep === `${prefix}.response`,
    );
    for (const call of rootCalls) {
      const assignments = assignmentMessages(
        call.messages as readonly ChatMessage[],
      );
      expect(assignments).toHaveLength(1);
      expect(assignments[0]!.content).toBe(expectedAssignment);
    }
    const resumedStep =
      policy === "execution-agent-v1"
        ? "execution.decision"
        : "worker.evidence";
    const resumed = modelCalls
      .filter((call) => call.modelStep === resumedStep)
      .at(-1)!;
    const resumedContext = JSON.stringify(resumed.messages);
    expect(resumedContext).toContain(
      "runtime_semantic_compaction_checkpoint_v2",
    );
    expect(resumedContext).toContain(sourceFact);
    expect(resumedContext.length).toBeLessThan(sourceBody.length / 2);
    expect(rootCalls.at(-1)!.modelStep).toBe(`${prefix}.response`);
  },
  20_000,
);
