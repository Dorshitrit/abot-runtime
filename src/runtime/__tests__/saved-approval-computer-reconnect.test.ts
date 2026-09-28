import { afterEach, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import type { SessionRecord } from "../../sessions/types.js";
import { successResult } from "../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { prepareSystemRequestModules } from "../../../plugins/system/source/request-system-modules.js";
import { createExecApprovalScript } from "./support/exec-sensitive-approval-script.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";
import { makeOwnerControlPeer } from "./support/local-runtime-owner-peer.js";
import {
  connectedSystemHost,
  selectedSystemModules,
  systemRequestPluginFixture,
} from "./support/system-request-plugin-fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
  resetDebugLoggerConfig();
});

function includeSystemScope(
  model: ReturnType<typeof createExecApprovalScript>,
) {
  const invoke = model.invoke.getMockImplementation()!;
  model.invoke.mockImplementation(async (input) => {
    const result = await invoke(input);
    if (!input.modelStep?.endsWith(".decision")) return result;
    const parsed = JSON.parse(result.text);
    const scope = parsed.decision?.workerCapabilityScope ?? parsed.decision;
    if (!Array.isArray(scope?.catalogGroupIds)) return result;
    scope.catalogGroupIds.push("system");
    return { ...result, text: JSON.stringify(parsed) };
  });
}

const restartCases = [
  { availability: "reconnected", mixedScope: false },
  { availability: "reconnected", mixedScope: true },
  { availability: "unavailable", mixedScope: false },
  { availability: "unavailable", mixedScope: true },
] as const;

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  test.each(restartCases)(
    `${policy} resumes once with computers $availability and mixed scope $mixedScope`,
    async ({ availability, mixedScope }) => {
      const base = await createSchedulerRuntimeFixture(policy);
      await base.application.stop();
      cleanup.push(() => base.dispose());
      const system = systemRequestPluginFixture();
      const initialTargets = await system.observeTargets();
      const prepareRequest: ToolModuleDeclaration["prepareRequest"] = (
        modules,
        context,
      ) =>
        prepareSystemRequestModules(
          base.config.paths.rootDir,
          modules,
          {
            observeTargets: system.observeTargets,
            connection: system,
          },
          context,
        );
      const systemModules = selectedSystemModules([
        "system_targets",
        "computer_desktops",
        "computer_observe",
        "computer_act",
      ]).map((module) => ({ ...module, prepareRequest }));
      const execute = vi.fn(async () =>
        successResult({ output: "Fixture completed." }),
      );
      const effect: ToolModuleDeclaration = {
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
              summary: "Record a fixture effect.",
              effect: "mutating",
              approval: "request_policy",
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
      const model = createExecApprovalScript(
        policy,
        [{ capabilityId: "record_approval_effect", controls: {} }],
        "approval_fixture",
      );
      if (mixedScope) includeSystemScope(model);
      const { peer } = makeOwnerControlPeer("computer-reconnect");
      const start = async () => {
        const owner = await createLocalRuntimeOwner(base.config, {
          models: model,
          tools: createConfiguredToolRegistry(base.config, [
            ...systemModules,
            effect,
          ]),
        });
        cleanup.push(async () => {
          await owner.stop();
          await owner.whenIdle?.();
        });
        return owner;
      };
      const first = await start();
      expect(
        await first.call(
          "request.run",
          [
            {
              type: "run_request",
              requestId: "saved-request",
              sessionId: "session",
              text: "Perform the fixture action.",
              toolPermissionMode: "ask",
              agentMode: "reasoning",
              modelPreference: { profileId: "scheduled-model", scope: "all" },
            },
            { durableApprovals: true, approvalAvailable: true },
          ],
          peer,
        ),
      ).toMatchObject({ kind: "awaiting_approval" });
      expect(first.isIdle?.()).toBe(true);
      const pending = (await first.call(
        "request.approvals",
        ["session"],
        peer,
      )) as LocalPendingToolApproval[];
      expect(pending).toHaveLength(1);
      const modelCalls = model.invoke.mock.calls.length;
      await first.stop();
      await first.whenIdle?.();
      system.readHostStatus.mockResolvedValue({
        ...connectedSystemHost,
        connected: true,
        connectionId: "550e8400-e29b-41d4-a716-446655440099",
      });
      if (availability === "unavailable") {
        system.readHostStatus.mockResolvedValue({
          paired: true,
          connected: false,
        });
        const observed = await system.observeTargets();
        system.observeTargets.mockResolvedValue({ ...observed, targets: [] });
      }
      const restarted = await start();
      expect(
        await restarted.call("request.approvals", ["session"], peer),
      ).toEqual(pending);
      expect(model.invoke).toHaveBeenCalledTimes(modelCalls);
      expect(execute).not.toHaveBeenCalled();
      const approval = pending[0]!;
      const command = {
        sessionId: "session",
        requestId: "saved-request",
        approvalId: approval.request.approvalId,
        ...approval.wait!,
        commandId: "user-decision",
        approved: true,
      };
      const savedScopeUnavailable =
        availability === "unavailable" && mixedScope;
      if (savedScopeUnavailable) {
        expect(
          await restarted.call("request.approval.decide", [command], peer),
        ).toEqual({
          accepted: false,
          reason: "approval_resume_unavailable",
        });
        expect(
          await restarted.call("request.approvals", ["session"], peer),
        ).toEqual(pending);
        expect(execute).not.toHaveBeenCalled();
        expect(model.invoke).toHaveBeenCalledTimes(modelCalls);
        system.observeTargets.mockResolvedValue(initialTargets);
      }
      expect(
        await restarted.call("request.approval.decide", [command], peer),
      ).toEqual({ accepted: true });
      expect(
        await restarted.call("request.approval.decide", [command], peer),
      ).toEqual({ accepted: true, duplicate: true });
      await restarted.whenIdle?.();
      expect(execute).toHaveBeenCalledOnce();
      expect(
        await restarted.call("request.approvals", ["session"], peer),
      ).toEqual([]);
      const session = (await restarted.call(
        "sessions.getSessionById",
        ["session"],
        peer,
      )) as SessionRecord;
      expect(
        session.requests?.find(
          (request) => request.requestId === "saved-request",
        )?.status,
      ).toBe("completed");
      expect(system.executeHostOperation).not.toHaveBeenCalled();
    },
    20_000,
  );
}
