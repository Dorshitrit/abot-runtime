import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { SUPERVISOR_WORKER_V1_EXECUTION_POLICY } from "../request/role-executor-composition.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestExecutionScope } from "../request/execution-scope.js";
import {
  actionFingerprint,
  createApprovalRunnerFixture,
} from "./support/request-approval-runner-fixture.js";
import {
  deriveTestRequestExecutionScope,
  rebindTestRequestExecutionPolicy,
} from "./support/request-execution-scope.js";
import {
  supervisorFormatName,
  withSupervisorPreparation,
} from "./support/supervisor-model-phases.js";

const objective = "Observe the exact original target and report its outcome.";
const capabilityDecision = {
  action: "invoke_capability",
  capabilityId: "fixture.observe",
  intent: "Observe the original target.",
};
const decision = (value: unknown) => JSON.stringify({ decision: value });

function createDelegatedApprovalFixture() {
  const approval = createApprovalRunnerFixture();
  const onEvent = vi.fn();
  const invokeRaw = vi.fn<ModelGatewayClient["invokeRaw"]>(async () => {
    throw new Error("unexpected raw gateway call");
  });
  const store = {
    list: vi.fn(() => [{ skillId: "approval-guide", name: "Approval guide", description: "Guidance for an approved observation." }]),
    read: vi.fn(),
  };
  const selectSkills = vi.fn(() => ({ action: "continue" }));
  let routeCount = 0;
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
                  roleId: "worker",
                  objective,
                  workerCapabilityScope: { catalogGroupIds: ["other"] },
                }
              : { action: "respond" },
          ),
          meta: {},
        };
      }
      if (input.modelStep === "worker.decision") {
        workerCount += 1;
        return {
          text: decision(
            workerCount === 1
              ? capabilityDecision
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
    }, { selectSkills }),
  );
  const makeRequest = () => {
    const request = deriveTestRequestExecutionScope(
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
    return createRequestExecutionScope({
      seed: request, executionPolicy: request.executionPolicy, knowledgeSkillStore: store,
      createWorkerCapabilities: () => request.workerCapabilities.provider,
    });
  };
  const delegations = () =>
    onEvent.mock.calls
      .filter(([name]) => name === "role.delegated")
      .map(([, payload]) => payload);
  return { ...approval, makeRequest, invoke, invokeRaw, delegations, store, selectSkills };
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("SUPER delegation events across saved approval continuation", () => {
  test.each([true, false])(
    "emits the admitted child once and does not repeat it after approval=%s",
    async (approved) => {
      const fixture = createDelegatedApprovalFixture();
      const waiting = await runRequestRunner(fixture.makeRequest(), {
        durableApproval: true,
      });
      if (waiting.kind !== "awaiting_approval")
        throw new Error("expected saved approval wait");
      const admittedDelegations = fixture.delegations();
      expect(admittedDelegations).toEqual([
        {
          callerCallId: "call-1",
          callerRole: "supervisor",
          childCallId: "call-2",
          childRole: "worker",
          objective,
        },
      ]);
      expect(fixture.prepare).toHaveBeenCalledOnce();
      expect(fixture.performed).not.toHaveBeenCalled();
      expect(fixture.selectSkills).toHaveBeenCalledOnce();
      expect(fixture.store.read).not.toHaveBeenCalled();
      const persisted = JSON.parse(JSON.stringify(waiting.continuation));
      expect(persisted.ledger.state.calls).toHaveLength(2);
      expect(persisted.ledger.state.calls[1]).toMatchObject({
        callId: "call-2",
        parentCallId: "call-1",
        roleId: "worker",
        objective,
      });
      expect(persisted.callers).toHaveLength(1);
      expect(persisted.preparedGroup.callId).toBe("call-2");
      const beforeResume = fixture.invoke.mock.calls.map(
        ([input]) => supervisorFormatName(input) ?? input.modelStep,
      );
      expect(beforeResume).toEqual([
        "supervisor_presentation",
        "supervisor_skill_selection",
        "supervisor_procedure_gate",
        "supervisor_delegation",
        "supervisor_working_directory",
        "worker.decision",
        "capability.controls",
      ]);

      const resumed = await runRequestRunner(fixture.makeRequest(), {
        durableApproval: true,
        continuation: persisted,
        decisions: [
          {
            approvalId: "approval-exact",
            actionFingerprint,
            decision: { approved },
          },
        ],
      });
      expect(resumed).toEqual({
        kind: "completed",
        result: { output: "The delegated action settled." },
      });
      expect(fixture.delegations()).toEqual(admittedDelegations);
      expect(fixture.selectSkills).toHaveBeenCalledTimes(2);
      expect(fixture.store.read).not.toHaveBeenCalled();
      expect(fixture.prepare).toHaveBeenCalledOnce();
      expect(fixture.restore).toHaveBeenCalledOnce();
      expect(fixture.executed).toHaveBeenCalledExactlyOnceWith(
        "capability-execution-1",
      );
      expect(fixture.performed).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(fixture.appliedDecisions).toHaveBeenCalledExactlyOnceWith({
        approvalId: "approval-exact",
        actionFingerprint,
        decision: { approved },
      });
      expect(
        fixture.invoke.mock.calls
          .slice(beforeResume.length)
          .map(([input]) => supervisorFormatName(input) ?? input.modelStep),
      ).toEqual([
        "worker.decision",
        "worker.result",
        "supervisor_skill_selection",
        "supervisor_decision",
        "supervisor.response",
      ]);
      expect(fixture.invokeRaw).not.toHaveBeenCalled();
      expect(fixture.onAcknowledgement).toHaveBeenCalledOnce();
      expect(fixture.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
        "The delegated action settled.",
      );
    },
  );
});
