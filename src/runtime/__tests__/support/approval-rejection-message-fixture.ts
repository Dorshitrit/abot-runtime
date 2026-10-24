import { vi } from "vitest";
import type { ToolModuleDeclaration } from "../../../capabilities/tool-types.js";
import type { SessionRecord } from "../../../sessions/types.js";
import { successResult } from "../../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createLocalRuntimeOwner } from "../../local-host/app-owner.js";
import type { LocalPendingToolApproval } from "../../local-host/request-approval-contracts.js";
import { createExecApprovalScript } from "./exec-sensitive-approval-script.js";
import { makeOwnerControlPeer } from "./local-runtime-owner-peer.js";
import { createSchedulerRuntimeFixture } from "./scheduler-runtime-fixture.js";

export type ApprovalRejectionScenario = Readonly<{
  policy: "execution-agent-v1" | "supervisor-worker-v1";
  mode: "ask" | "full_access";
  approval: "request_policy" | "always";
}>;

export async function createApprovalRejectionMessageFixture(
  scenario: ApprovalRejectionScenario,
  cleanup: Array<() => Promise<void>>,
) {
  const base = await createSchedulerRuntimeFixture(scenario.policy);
  await base.application.stop();
  cleanup.push(() => base.dispose());
  const model = createExecApprovalScript(
    scenario.policy,
    [{ capabilityId: "record_approval_effect", controls: {} }],
    "approval_fixture",
  );
  const execute = vi.fn(async () =>
    successResult({ output: "The approved effect completed." }),
  );
  const module: ToolModuleDeclaration = {
    definition: {
      name: "approval_fixture_effect",
      routingCapability: "semantic_mutation",
      catalogGroups: ["approval_fixture"],
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: "record_approval_effect",
          summary: "Record an effect.",
          effect: "mutating",
          approval: scenario.approval,
          input: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: [],
          },
        },
      ],
    },
    implementation: execute,
  };
  const { peer } = makeOwnerControlPeer("rejection-message-view");
  const start = async () => {
    const owner = await createLocalRuntimeOwner(base.config, {
      models: model,
      tools: createConfiguredToolRegistry(base.config, [module]),
    });
    cleanup.push(async () => {
      await owner.stop();
      await owner.whenIdle?.();
    });
    return owner;
  };
  let owner = await start();
  await owner.call(
    "request.run",
    [
      {
        type: "run_request",
        requestId: "message-rejection",
        sessionId: "session",
        text: "Perform the fixture action.",
        toolPermissionMode: scenario.mode,
        agentMode: "reasoning",
        modelPreference: { profileId: "scheduled-model", scope: "all" },
      },
      { durableApprovals: true, approvalAvailable: true },
    ],
    peer,
  );
  const [pending] = (await owner.call(
    "request.approvals",
    ["session"],
    peer,
  )) as LocalPendingToolApproval[];
  if (!pending?.wait) throw new Error("expected_saved_approval_wait");
  const command = {
    sessionId: "session",
    requestId: "message-rejection",
    approvalId: pending.request.approvalId,
    ...pending.wait,
    commandId: "rejection-message-command",
  };
  return {
    model,
    execute,
    command,
    async restart() {
      await owner.stop();
      await owner.whenIdle?.();
      owner = await start();
    },
    decide(decision: Readonly<{ approved: boolean; reason?: string }>) {
      return owner.call(
        "request.approval.decide",
        [{ ...command, ...decision }],
        peer,
      );
    },
    async settledSession() {
      await owner.whenIdle?.();
      return owner.call(
        "sessions.getSessionById",
        ["session"],
        peer,
      ) as Promise<SessionRecord>;
    },
  };
}
