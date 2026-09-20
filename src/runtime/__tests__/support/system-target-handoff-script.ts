import { expect } from "vitest";
import type { ModelGatewayClient } from "../../ports.js";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { CAPABILITY_CONTROLS_MODEL_STEP } from "../../orchestration/worker-capabilities/index.js";
import { finalDispatchReport } from "./system-target-handoff-fixture.js";

export type HandoffModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
export type HandoffScriptCall = {
  step: HandoffModelInput["modelStep"];
  output: string | ((input: HandoffModelInput) => string);
};
const decision = (value: unknown) => JSON.stringify({ decision: value });
const plannerObjective = "Coordinate the requested launch on Windows.";
const workerObjective =
  "Discover the Windows application and dispatch its launch.";

export function readHandoffCapsule(
  input: HandoffModelInput,
  kind: string,
): Record<string, any> {
  for (const message of [
    ...(input.messages as readonly ChatMessage[]),
  ].reverse()) {
    try {
      const value = JSON.parse(message.content);
      if (value.kind === kind) return value;
    } catch {
      /* prose is not a capsule */
    }
  }
  throw new Error(`missing_capsule:${kind}`);
}

function selectApplication(): HandoffScriptCall[] {
  return [
    {
      step: "worker.decision",
      output: decision({
        action: "invoke_capability",
        capabilityId: "discover_system_applications",
        intent: "Find the requested application on Windows.",
      }),
    },
    {
      step: CAPABILITY_CONTROLS_MODEL_STEP,
      output: decision({
        action: "invoke_capability",
        controls: { target: "windows", query: "Fixture", limit: 50 },
      }),
    },
  ];
}

export function createTargetHandoffScript(
  assertApplicationEvidence: (input: HandoffModelInput) => void,
): HandoffScriptCall[] {
  return [
    {
      step: "supervisor.decision",
      output: decision({
        action: "invoke_role",
        roleId: "planner",
        objective: plannerObjective,
        acknowledgement: "I will inspect and launch the requested application.",
      }),
    },
    {
      step: "supervisor.decision",
      output: JSON.stringify({ workingDirectory: "." }),
    },
    {
      step: "planner.decision",
      output: decision({
        action: "invoke_role",
        roleId: "worker",
        plan: {
          summary: plannerObjective,
          items: [
            {
              title: "Launch requested application",
              objective: workerObjective,
            },
          ],
        },
        selectedItemIndexes: [0],
        workerCapabilityScope: { catalogGroupIds: ["system"] },
      }),
    },
    ...selectApplication(),
    {
      step: "worker.decision",
      output: (input) => {
        assertApplicationEvidence(input);
        expect(JSON.stringify(input.messages)).toContain("Fixture.App");
        return decision({
          action: "invoke_capability",
          capabilityId: "launch_system_application",
          intent:
            "Dispatch launch for the observed identity on the same Windows host.",
        });
      },
    },
    {
      step: CAPABILITY_CONTROLS_MODEL_STEP,
      output: decision({
        action: "invoke_capability",
        controls: {
          target: "windows",
          application_id: "Fixture.App",
          arguments: [],
        },
      }),
    },
    {
      step: "worker.decision",
      output: (input) => {
        expect(JSON.stringify(input.messages)).toContain(
          "launch_request_dispatch",
        );
        return decision({ action: "return_result" });
      },
    },
    { step: "worker.result", output: finalDispatchReport },
    {
      step: "planner.decision",
      output: (input) => {
        expect(readHandoffCapsule(input, "runtime_child_result")).toMatchObject(
          {
            callerCallId: "call-2",
            childCallId: "call-3",
            roleId: "worker",
            delegatedObjective: workerObjective,
            summary: finalDispatchReport,
            outcome: "completed",
          },
        );
        return decision({
          action: "return_result",
          result: finalDispatchReport,
        });
      },
    },
    {
      step: "supervisor.decision",
      output: (input) => {
        expect(readHandoffCapsule(input, "runtime_child_result")).toMatchObject(
          {
            callerCallId: "call-1",
            childCallId: "call-2",
            roleId: "planner",
            summary: finalDispatchReport,
            outcome: "completed",
          },
        );
        return decision({ action: "invoke_role", roleId: "reviewer" });
      },
    },
    {
      step: "reviewer.decision",
      output: (input) => {
        const audit = readHandoffCapsule(input, "runtime_reviewer_audit_v4");
        expect(audit.dependencySubjects).toEqual([
          expect.objectContaining({ roleId: "planner", outcome: "completed" }),
        ]);
        expect(audit.effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ outcome: "succeeded" }),
          ]),
        );
        expect(audit.effects).toHaveLength(2);
        expect(audit.effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              evidenceRef: "capability-execution-2",
              summary: "Launch request dispatched; visible window not checked.",
              subjectRefs: ["call:call-2"],
            }),
          ]),
        );
        return decision({
          action: "report_gaps",
          reviewScopeId: audit.auditScope.reviewScopeId,
          summary:
            "Launch dispatch is established; independent GUI visibility is absent.",
          audit: {
            evidenceAssessments: audit.effects.map(
              (effect: { evidenceRef: string }) => ({
                evidenceRef: effect.evidenceRef,
                status: "supports",
                finding:
                  "The host observation or dispatch succeeded without proving GUI visibility.",
              }),
            ),
            completionAssessment: {
              status: "gap",
              evidenceRefs: audit.effects.map(
                (effect: { evidenceRef: string }) => effect.evidenceRef,
              ),
              finding: "No independent visible window observation exists.",
            },
          },
          gaps: [
            {
              kind: "missing_evidence",
              subjectRefs: [],
              factRefs: [],
              evidenceRefs: [],
              summary: "Visible window was not independently checked.",
            },
          ],
        });
      },
    },
    {
      step: "supervisor.decision",
      output: (input) => {
        expect(readHandoffCapsule(input, "runtime_child_result")).toMatchObject(
          {
            callerCallId: "call-1",
            roleId: "reviewer",
            reviewerVerdict: { verdict: "report_gaps" },
          },
        );
        return decision({ action: "respond" });
      },
    },
    { step: "supervisor.response", output: finalDispatchReport },
  ];
}
