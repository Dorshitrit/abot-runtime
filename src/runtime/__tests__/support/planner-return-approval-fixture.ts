import { vi } from "vitest";
import type { ModelGatewayClient } from "../../ports.js";
import { SUPERVISOR_WORKER_V1_EXECUTION_POLICY } from "../../request/role-executor-composition.js";
import { createApprovalRunnerFixture } from "./request-approval-runner-fixture.js";
import {
  deriveTestRequestExecutionScope,
  rebindTestRequestExecutionPolicy,
} from "./request-execution-scope.js";
import {
  supervisorFormatName,
  withSupervisorPreparation,
} from "./supervisor-model-phases.js";

export const plannerObjective = "Coordinate the exact original target action.";
export const workerObjective = "Observe the original target and report its outcome.";
const decision = (value: unknown) => JSON.stringify({ decision: value });

export function createPlannerReturnApprovalFixture(approved: boolean) {
  const approval = createApprovalRunnerFixture();
  const onEvent = vi.fn();
  const summary = approved
    ? "The original target was observed."
    : "The user declined the original target action.";
  const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>(async () => {
    throw new Error("unexpected raw gateway call");
  });
  let routeCount = 0;
  let plannerCount = 0;
  let workerCount = 0;
  const invoke = vi.fn<ModelGatewayClient["invoke"]>(
    withSupervisorPreparation(async (input) => {
      if (supervisorFormatName(input) === "supervisor_working_directory")
        return { text: JSON.stringify({ workingDirectory: "." }), meta: {} };
      if (input.modelStep === "supervisor.decision") {
        routeCount += 1;
        return {
          text: decision(
            routeCount === 1
              ? {
                  action: "invoke_role",
                  roleId: "planner",
                  objective: plannerObjective,
                }
              : { action: "respond" },
          ),
          meta: {},
        };
      }
      if (input.modelStep === "planner.decision") {
        plannerCount += 1;
        const terminal = approved
          ? { action: "return_result", result: summary }
          : { action: "return_failure", reason: summary };
        return {
          text: decision(
            plannerCount === 1
              ? {
                  action: "invoke_role",
                  roleId: "worker",
                  plan: {
                    summary: plannerObjective,
                    items: [{ title: "Observe", objective: workerObjective }],
                  },
                  selectedItemIndexes: [0],
                  workerCapabilityScope: { catalogGroupIds: ["other"] },
                }
              : terminal,
          ),
          meta: {},
        };
      }
      if (input.modelStep === "worker.decision") {
        workerCount += 1;
        return {
          text: decision(
            workerCount === 1
              ? {
                  action: "invoke_capability",
                  capabilityId: "fixture.observe",
                  intent: "Observe the original target.",
                }
              : { action: "return_result" },
          ),
          meta: {},
        };
      }
      if (input.modelStep === "capability.controls")
        return {
          text: decision({ action: "invoke_capability", controls: {} }),
          meta: {},
        };
      if (input.modelStep === "worker.result")
        return { text: "The original target action settled.", meta: {} };
      if (input.modelStep === "supervisor.response")
        return { text: "The delegated action settled.", meta: {} };
      throw new Error(`unexpected model step: ${input.modelStep}`);
    }),
  );
  const makeRequest = () =>
    deriveTestRequestExecutionScope(
      rebindTestRequestExecutionPolicy(
        approval.makeRequest(),
        SUPERVISOR_WORKER_V1_EXECUTION_POLICY,
      ),
      {
        runnerConfig: {
          models: { defaults: { profileId: "unused", steps: {} } },
          context: {
            outputReserveTokens: 128,
            safetyReserveTokens: 64,
            attachmentReserveTokens: 32,
          },
          steps: {
            "supervisor.decision": { timeoutMs: 20_000 },
            "supervisor.response": { timeoutMs: 20_000 },
            "planner.decision": { timeoutMs: 20_000 },
            "worker.decision": { timeoutMs: 20_000 },
            "worker.result": { timeoutMs: 20_000 },
            "capability.controls": { timeoutMs: 20_000 },
          },
        },
        modelPolicy: {
          providers: { local: { type: "ollama" } },
          profiles: {
            unused: {
              provider: "local",
              model: "test",
              contextWindowTokens: 32_000,
            },
          },
          defaults: { profileId: "unused", steps: {} },
        },
        modelGatewayClient: { invoke, invokeRaw },
        onEvent,
      },
    );
  const events = (eventName: string) =>
    onEvent.mock.calls
      .filter(([name]) => name === eventName)
      .map(([, payload]) => payload);
  return { ...approval, makeRequest, invoke, invokeRaw, events, summary };
}
