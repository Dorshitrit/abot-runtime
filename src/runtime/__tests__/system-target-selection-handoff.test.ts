import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runRequestRunner } from "../request/runner.js";
import { createRequestWorkerCapabilityProvider } from "../request/worker-capability-composition.js";
import { SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT } from "../orchestration/role-calls/index.js";
import { createTestRequestExecutionScopeWithCapabilities } from "./support/request-execution-scope.js";
import {
  createTargetHandoffFixture,
  finalDispatchReport,
  selectedHost,
  selectedConnection,
  targetHandoffSeed,
} from "./support/system-target-handoff-fixture.js";
import {
  createTargetHandoffScript,
  readHandoffCapsule,
} from "./support/system-target-handoff-script.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

describe("plugin target evidence survives the complete delegated request", () => {
  test.each(["ask", "full_access", "full_plus"] as const)(
    "%s keeps implicit host binding and approval through Worker and Reviewer",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "target-handoff-"));
      const fixture = createTargetHandoffFixture(root);
      await mkdir(fixture.config.paths.agentWorkDir);
      const script = createTargetHandoffScript((input) => {
        expect(fixture.executeHostOperation).toHaveBeenCalledOnce();
        const evidence = readHandoffCapsule(
          input,
          "runtime_request_tool_results_v1",
        );
        expect(evidence).toMatchObject({
          authority: "reference_data",
          coverage: { kind: "call", callId: "call-3" },
          results: [
            {
              callId: "call-3",
              outcome: "succeeded",
              acceptedAction: {
                controls: { target: "windows", query: "Fixture", limit: 50 },
              },
              adapterResult: {
                authority: "registered_plugin",
                result: {
                  ok: true,
                  data: { transport: "host_companion", observedMatches: 1 },
                },
              },
            },
          ],
        });
        expect(
          readHandoffCapsule(input, "runtime_worker_assignment"),
        ).toMatchObject({ callId: "call-3", parentCallId: "call-2" });
      });
      let nextCall = 0;
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(async (input) => {
        const visible = JSON.stringify({
          messages: input.messages,
          format: input.format,
        });
        expect(visible).not.toContain(selectedHost);
        expect(visible).not.toContain(selectedConnection);
        expect(visible).not.toContain("host_id");
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
      const seed = targetHandoffSeed(invoke, mode);
      const preparedRegistry = await fixture.registry.prepareRequest!();
      const request = createTestRequestExecutionScopeWithCapabilities(
        seed,
        (view) =>
          createRequestWorkerCapabilityProvider({
            request: view,
            executionPolicyAuthority: SUPERVISOR_WORKER_V1_AUTHORITY_SNAPSHOT,
            runtimeConfig: fixture.config,
            toolRegistryOverride: preparedRegistry,
          }),
      );
      try {
        await expect(runRequestRunner(request)).resolves.toEqual({
          output: finalDispatchReport,
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
