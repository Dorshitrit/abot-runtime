import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withSupervisorPreparation } from "./support/supervisor-model-phases.js";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./support/request-execution-scope.js";
import {
  createTargetHandoffFixture,
  finalDispatchReport,
  selectedHost,
  selectedConnection,
} from "./support/system-target-handoff-fixture.js";
import { readHandoffCapsule } from "./support/system-target-handoff-script.js";
import { createTargetEaScript, targetEaSeed } from "./support/system-target-ea-script.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("plugin target evidence survives the complete EA request", () => {
  test.each(["ask", "full_access", "full_plus"] as const)(
    "%s keeps implicit host binding and approval from discovery through launch",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "target-handoff-"));
      const fixture = createTargetHandoffFixture(root);
      await mkdir(fixture.config.paths.agentWorkDir);
      const executionPolicy = resolveRequestExecutionPolicy("execution-agent-v1");
      const script = createTargetEaScript((input) => {
        expect(fixture.executeHostOperation).toHaveBeenCalledOnce();
        const evidence = readHandoffCapsule(
          input,
          "runtime_execution_capability_result_v1",
        );
        expect(evidence).toMatchObject({
          authority: "canonical_role_call_ledger",
          result: {
              executionId: "capability-execution-1",
              capabilityId: "discover_system_applications",
              outcome: "succeeded",
              adapterResult: {
                authority: "registered_plugin",
                result: {
                  ok: true,
                  data: { transport: "host_companion", observedMatches: 1 },
                },
              },
          },
        });
      });
      let nextCall = 0;
      const respond = withSupervisorPreparation(async (input) => {
        const call = script[nextCall++];
        expect(
          call,
          `unexpected model call ${nextCall}: ${input.modelStep}`,
        ).toBeDefined();
        expect(input.modelStep).toBe(call!.step);
        return {
          text:
            typeof call!.output === "string"
              ? call!.output
              : call!.output(input),
          meta: {},
        };
      });
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
        const visible = JSON.stringify({ messages: input.messages, format: input.format });
        expect(visible).not.toContain(selectedHost);
        expect(visible).not.toContain(selectedConnection);
        expect(visible).not.toContain("host_id");
        return respond(input);
      });
      const seed = targetEaSeed(invoke, mode);
      const preparedRegistry = await fixture.registry.prepareRequest!({
        requestId: seed.requestId, executionPolicy: executionPolicy.authority.id,
        rootContractId: executionPolicy.rootContract.contractId,
      });
      const request = createTestRequestExecutionScopeWithCapabilities(
        seed,
        (view) =>
          createRequestWorkerCapabilityProvider({
            request: view,
            executionPolicyAuthority: executionPolicy.authority,
            runtimeConfig: fixture.config,
            toolRegistryOverride: preparedRegistry,
          }),
        { executionPolicy },
      );
      try {
        const result = await runRequestRunner(request);
        expect(result).toMatchObject({
          output: finalDispatchReport,
          outputTextMode: "exact",
        });
        expect(JSON.parse(result.finalObservation!.observationContent)).toMatchObject({
          kind: "runtime_execution_tool_observation_v1",
          results: [
            expect.objectContaining({ capabilityId: "discover_system_applications", outcome: "succeeded" }),
            expect.objectContaining({ capabilityId: "launch_system_application", outcome: "succeeded" }),
          ],
        });
        expect(nextCall).toBe(script.length);
        expect(fixture.run).not.toHaveBeenCalled();
        expect(fixture.readHostStatus).toHaveBeenCalledOnce();
        expect(
          fixture.executeHostOperation.mock.calls.map(([, input]) => ({
            hostId: input.hostId,
            connectionId: input.connectionId,
            operation: input.operation,
            params: input.params,
          })),
        ).toEqual([
          {
            hostId: selectedHost,
            connectionId: selectedConnection,
            operation: "system_applications",
            params: { target: "windows", query: "Fixture", limit: 50 },
          },
          {
            hostId: selectedHost,
            connectionId: selectedConnection,
            operation: "system_launch",
            params: {
              target: "windows",
              application_id: "Fixture.App",
              arguments: [],
            },
          },
        ]);
        const approval = vi.mocked(
          seed.toolApprovalController!.requestToolApproval,
        );
        if (mode === "full_plus") expect(approval).not.toHaveBeenCalled();
        else
          expect(approval.mock.calls.map(([entry]) => entry.call)).toEqual([
            {
              tool: "system_applications",
              params: { target: "windows", query: "Fixture", limit: 50 },
            },
            {
              tool: "system_launch",
              params: {
                target: "windows",
                application_id: "Fixture.App",
                arguments: [],
              },
            },
          ]);
        for (const [entry] of approval.mock.calls) {
          expect(entry.meta).toMatchObject({
            displayTarget: "windows",
            computerName: "Fixture computer",
            transport: "host_companion",
          });
          expect(JSON.stringify(entry)).not.toContain(selectedHost);
          expect(JSON.stringify(entry)).not.toContain(selectedConnection);
        }
        expect(seed.onAnswerToken).toHaveBeenCalledExactlyOnceWith(
          finalDispatchReport,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
