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

function descriptionEntries(input: ModelInput): unknown {
  const briefs = messages(input).filter(isCapabilityBriefMessage);
  expect(briefs).toHaveLength(1);
  const content = briefs[0]!.content;
  const start = content.indexOf("\n[");
  expect(
    start,
    "routing brief must include the canonical description array",
  ).toBeGreaterThanOrEqual(0);
  return JSON.parse(content.slice(start + 1));
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
  "Supervisor sees request-prepared SYSTEM descriptions with connection=%s",
  async (connected) => {
    const result = await runSystemBriefRequest({ connected });
    expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
    expect(result.session?.messages.at(-1)?.content).toBe(EXEC_APPROVAL_FINAL);
    expect(result.prepare).toHaveBeenCalledOnce();
    expect(result.host.readHostStatus).toHaveBeenCalledOnce();
    const inputs = result.model.invoke.mock.calls.map(([input]) => input);
    const routing = inputs.find(
      ({ modelStep }) => modelStep === "supervisor.decision",
    )!;
    const canonicalEntries = result.offered.map(
      ({ toolName, operationId, summary, catalogGroups }) => ({
        toolName,
        operationId,
        summary,
        catalogGroups,
      }),
    );
    expect(descriptionEntries(routing)).toEqual(canonicalEntries);
    expect(canonicalEntries).toHaveLength(4);
    const expectedTargets = connected ? "linux, windows" : "linux";
    for (const entry of canonicalEntries) {
      expect(entry.summary).toContain(
        `Available targets for this request: ${expectedTargets}.`,
      );
    }
    if (!connected)
      expect(JSON.stringify(descriptionEntries(routing))).not.toContain(
        "windows",
      );
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
    expect(result.host.executeHostOperation).toHaveBeenCalledExactlyOnceWith(
      "/runtime",
      expect.objectContaining({
        hostId: requestHostId,
        connectionId: requestConnectionId,
        operation: "system_command",
        params: SYSTEM_BRIEF_CONTROLS,
      }),
    );
    expect(result.host.native).not.toHaveBeenCalled();
    const inputs = result.model.invoke.mock.calls.map(([input]) => input);
    for (const input of inputs) {
      const isRouting =
        input.modelStep === "supervisor.decision" &&
        typeof input.format === "object" &&
        input.format?.name === "supervisor_decision";
      if (isRouting) {
        expect(descriptionEntries(input)).toEqual(
          result.offered.map(
            ({ toolName, operationId, summary, catalogGroups }) => ({
              toolName,
              operationId,
              summary,
              catalogGroups,
            }),
          ),
        );
        continue;
      }
      expect(messages(input).filter(isCapabilityBriefMessage)).toEqual([]);
    }
    const selectingStep =
      policy === "execution-agent-v1"
        ? "execution.decision"
        : "worker.decision";
    expect(
      inputs.filter(({ modelStep }) => modelStep === selectingStep).length,
    ).toBeGreaterThan(1);
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
