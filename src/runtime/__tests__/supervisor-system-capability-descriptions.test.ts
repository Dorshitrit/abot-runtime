import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ToolAvailabilityEntry } from "../../capabilities/tool-types.js";
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

function assertPluginDiscovery(
  input: ModelInput,
  offered: readonly ToolAvailabilityEntry[],
): void {
  const briefs = messages(input).filter(isCapabilityBriefMessage);
  expect(briefs).toHaveLength(1);
  const content = briefs[0]!.content;
  expect(content.split("\n").slice(-2).join("\n")).toBe(
    "Tool groups: system: system [computer_act, computer_desktops, computer_observe, system_applications, system_command, system_launch, system_targets]\nPlugin descriptions: system: Run OS commands, discover and launch apps, inspect and control desktops.",
  );
  for (const entry of offered) {
    expect(content).not.toContain(entry.operationId);
    expect(content).not.toContain(entry.summary);
  }
}

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
  "Supervisor procedure gate stays independent of SYSTEM discovery with connection=%s",
  async (connected) => {
    const result = await runSystemBriefRequest({ connected });
    expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
    expect(result.session?.messages.at(-1)?.content).toBe(EXEC_APPROVAL_FINAL);
    expect(result.prepare).toHaveBeenCalledOnce();
    expect(result.host.readHostStatus).toHaveBeenCalledOnce();
    const inputs = result.model.invoke.mock.calls.map(([input]) => input);
    const routing = inputs.find(
      ({ format }) => typeof format === "object" && format?.name === "supervisor_procedure_gate",
    )!;
    expect(messages(routing).filter(isCapabilityBriefMessage)).toEqual([]);
    expect(result.offered).toHaveLength(14);
    const prepared = await result.prepare.mock.results[0]!.value;
    const expectedTargets = connected ? ["linux", "windows"] : ["linux"];
    for (const module of prepared) {
      for (const operation of module.normalInvocation.operations) {
        const properties = operation.input.properties;
        if (properties.target) expect(properties.target).toEqual({ type: "string", enum: expectedTargets });
        if (properties.desktop_ref && "enum" in properties.desktop_ref)
          expect(properties.desktop_ref.enum).toHaveLength(connected ? 2 : 1);
      }
    }
    expect(
      messages(routing).filter(
        ({ role, content }) =>
          role === "user" && content === SYSTEM_BRIEF_PROMPT,
      ),
    ).toHaveLength(1);
    for (const input of inputs.filter(
      ({ modelStep }) => modelStep !== "supervisor.decision",
    )) {
      expect(messages(input).filter(isCapabilityBriefMessage)).toEqual([]);
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

test.each(["supervisor-worker-v1", "execution-agent-v1"] as const)(
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
      const isRouting =
        input.modelStep === "supervisor.decision" &&
        typeof input.format === "object" &&
        input.format?.name === "supervisor_decision";
      if (isRouting) {
        assertPluginDiscovery(input, result.offered);
        continue;
      }
      expect(messages(input).filter(isCapabilityBriefMessage)).toEqual([]);
    }
    const selectingStep =
      policy === "execution-agent-v1"
        ? "execution.decision"
        : "worker.decision";
    const selectionCalls = inputs.filter(({ modelStep }) => modelStep === selectingStep);
    if (policy === "execution-agent-v1") expect(selectionCalls.length).toBeGreaterThan(1);
    if (policy === "supervisor-worker-v1") {
      expect(selectionCalls).toHaveLength(1);
      expect(inputs.filter(({ modelStep }) => modelStep === "worker.evidence")).toHaveLength(2);
      const worker = inputs.find(({ modelStep }) => modelStep === selectingStep)!;
      const content = messages(worker).map(({ content }) => content).join("\n");
      for (const entry of result.offered)
        expect(content).toContain(JSON.stringify(entry.summary));
    }
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
