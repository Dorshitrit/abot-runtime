import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { isCapabilityBriefMessage } from "../context/capability-brief.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { EXEC_APPROVAL_FINAL } from "./support/exec-sensitive-approval-script.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import {
  requestHostId,
  requestConnectionId,
} from "./support/system-request-plugin-fixture.js";
import {
  runSystemBriefRequest,
  SYSTEM_BRIEF_CONTROLS,
  SYSTEM_BRIEF_PROMPT,
} from "./support/supervisor-system-brief-fixture.js";

type ModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
const messages = (input: ModelInput) =>
  input.messages as readonly ChatMessage[];

function assertNoConnectionIdentity(inputs: readonly ModelInput[]): void {
  const visible = JSON.stringify(
    inputs.map(({ messages, format }) => ({ messages, format })),
  );
  for (const privateValue of [
    requestHostId,
    requestConnectionId,
    "host_id",
    "connectionId",
  ]) {
    expect(visible).not.toContain(privateValue);
  }
}

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

test.each([true, false])(
  "SUPER excludes SYSTEM before preparation, discovery and routing with connection=%s",
  async (connected) => {
    const result = await runSystemBriefRequest({ connected });
    expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
    expect(result.session?.messages.at(-1)?.content).toBe(EXEC_APPROVAL_FINAL);
    expect(result.prepare).not.toHaveBeenCalled();
    expect(result.host.readHostStatus).not.toHaveBeenCalled();
    const inputs = result.model.invoke.mock.calls.map(([input]) => input);
    const routing = inputs.find(
      ({ format }) => typeof format === "object" && format?.name === "supervisor_procedure_gate",
    )!;
    expect(messages(routing).filter(isCapabilityBriefMessage)).toEqual([]);
    expect(result.offered).toEqual([]);
    expect(
      messages(routing).filter(
        ({ role, content }) =>
          role === "user" && content === SYSTEM_BRIEF_PROMPT,
      ),
    ).toHaveLength(1);
    for (const input of inputs) {
      expect(messages(input).filter(isCapabilityBriefMessage)).toEqual([]);
      expect(JSON.stringify({ messages: input.messages, format: input.format })).not.toContain("run_system_command");
    }
    assertNoConnectionIdentity(inputs);
    expect(result.host.executeHostOperation).not.toHaveBeenCalled();
    expect(result.host.native).not.toHaveBeenCalled();
    expect(result.model.invokeRaw).not.toHaveBeenCalled();
  },
);

test("disabled SYSTEM stays absent before snapshot and Supervisor routing", async () => {
  const result = await runSystemBriefRequest({ enabled: false });
  expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
  expect(result.session?.messages.at(-1)?.content).toBe(EXEC_APPROVAL_FINAL);
  expect(result.prepare).not.toHaveBeenCalled();
  expect(result.host.readHostStatus).not.toHaveBeenCalled();
  expect(result.offered).toEqual([]);
  for (const [input] of result.model.invoke.mock.calls) {
    expect(messages(input).filter(isCapabilityBriefMessage)).toEqual([]);
    expect(
      JSON.stringify({ messages: input.messages, format: input.format }),
    ).not.toContain("run_system_command");
  }
  expect(result.host.executeHostOperation).not.toHaveBeenCalled();
});

test.each(["execution-agent-v1"] as const)(
  "%s preserves selected controls and private host binding",
  async (policy) => {
    const result = await runSystemBriefRequest({ policy, execute: true });
    expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
    expect(result.session?.messages.at(-1)?.content).toBe(EXEC_APPROVAL_FINAL);
    expect(result.host.executeHostOperation).toHaveBeenNthCalledWith(1,
      "/runtime",
      expect.objectContaining({
        hostId: requestHostId,
        connectionId: requestConnectionId,
        operation: "system_command_capture",
        params: SYSTEM_BRIEF_CONTROLS,
      }),
    );
    const operations = result.host.executeHostOperation.mock.calls.map(([, call]) => call.operation);
    expect(operations).toEqual(["system_command_capture", "system_command_output", "system_command_output_close"]);
    for (const [, call] of result.host.executeHostOperation.mock.calls)
      expect(call).toMatchObject({ hostId: requestHostId, connectionId: requestConnectionId });
    expect(result.host.native).not.toHaveBeenCalled();
    const inputs = result.model.invoke.mock.calls.map(([input]) => input);
    for (const input of inputs) {
      expect(messages(input).filter(isCapabilityBriefMessage)).toEqual([]);
    }
    expect(inputs.filter(({ modelStep }) => modelStep === "execution.decision").length).toBeGreaterThan(1);
    const controlsInput = inputs.find(
      ({ modelStep }) => modelStep === "capability.controls",
    )!;
    expect(controlsInput).toBeDefined();
    expect(JSON.stringify(controlsInput.format)).toContain("windows");
    assertNoConnectionIdentity(inputs);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        name: "tool.completed",
        tool: "system_command",
        ok: true,
      }),
    );
    expect(result.model.invokeRaw).not.toHaveBeenCalled();
  },
);

test("SUPER cannot dispatch an explicitly attempted SYSTEM capability", async () => {
  const result = await runSystemBriefRequest({ policy: "supervisor-worker-v1", execute: true });
  expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
  expect(result.prepare).not.toHaveBeenCalled();
  expect(result.host.readHostStatus).not.toHaveBeenCalled();
  expect(result.offered).toEqual([]);
  expect(result.host.executeHostOperation).not.toHaveBeenCalled();
  expect(result.host.native).not.toHaveBeenCalled();
  expect(result.events.filter(({ name }) => name === "tool.started")).toEqual([]);
  assertNoConnectionIdentity(result.model.invoke.mock.calls.map(([input]) => input));
});

test.each([true, false])("EA prepares SYSTEM targets from the connection snapshot: connected=%s", async (connected) => {
  const result = await runSystemBriefRequest({ policy: "execution-agent-v1", connected });
  expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
  expect(result.prepare).toHaveBeenCalledOnce();
  expect(result.host.readHostStatus).toHaveBeenCalledOnce();
  expect(result.offered).toHaveLength(14);
  const prepared = await result.prepare.mock.results[0]!.value;
  for (const module of prepared) {
    for (const operation of module.normalInvocation.operations) {
      const properties = operation.input.properties;
      if (properties.target) expect(properties.target).toEqual({ type: "string", enum: connected ? ["linux", "windows"] : ["linux"] });
      if (properties.desktop_ref && "enum" in properties.desktop_ref)
        expect(properties.desktop_ref.enum).toHaveLength(connected ? 2 : 1);
    }
  }
  expect(result.host.executeHostOperation).not.toHaveBeenCalled();
  expect(result.host.native).not.toHaveBeenCalled();
  assertNoConnectionIdentity(result.model.invoke.mock.calls.map(([input]) => input));
});
