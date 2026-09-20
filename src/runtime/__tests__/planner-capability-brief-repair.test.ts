import { afterEach, beforeEach, expect, test } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { isCapabilityBriefMessage } from "../context/capability-brief.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runPlannerDecision } from "../steps/planner-decision/run.js";
import { buildPlannerCapabilityBriefOptions } from "../steps/planner-decision/capability-brief.js";
import { createPlannerBriefFixture } from "./support/planner-capability-brief-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function modelMessages(
  input: Parameters<ModelGatewayClient["invoke"]>[0],
): readonly ChatMessage[] {
  expect(Array.isArray(input.messages)).toBe(true);
  return input.messages as readonly ChatMessage[];
}

function nonBrief(messages: readonly ChatMessage[]) {
  return messages.filter((message) => !isCapabilityBriefMessage(message));
}

test("fresh Planner repair shrinks only the shared optional brief before admission", async () => {
  const ample = createPlannerBriefFixture();
  const fixture = createPlannerBriefFixture({
    contextWindowTokens: Math.ceil(
      (ample.input.context.budget.estimatedInputTokens + 2) / 0.7,
    ),
  });
  expect(fixture.input.capabilityBrief.level).toBe("descriptions");
  fixture.invoke.mockImplementation(async () => {
    const attempt = fixture.invoke.mock.calls.length;
    if (attempt === 1) return { text: "invalid first envelope", meta: {} };
    if (attempt === 2)
      return {
        text: JSON.stringify({ decision: { action: "unknown_action" } }),
        meta: {},
      };
    return {
      text: JSON.stringify({
        decision: {
          action: "return_failure",
          reason: "No further evidence in this bounded fixture.",
        },
      }),
      meta: {},
    };
  });
  await expect(
    runPlannerDecision(fixture.request, fixture.inputOptions),
  ).resolves.toMatchObject({ action: "return_failure" });
  expect(fixture.invoke).toHaveBeenCalledTimes(3);
  const inputs = fixture.invoke.mock.calls.map(([input]) => input);
  const original = nonBrief(modelMessages(inputs[0]!));
  expect(
    modelMessages(inputs[0]!).find(isCapabilityBriefMessage)?.content,
  ).toContain(JSON.stringify(fixture.entries[0]!.summary));
  for (const input of inputs.slice(1)) {
    const messages = modelMessages(input);
    expect(nonBrief(messages).slice(0, -1)).toEqual(original);
    expect(nonBrief(messages)).toHaveLength(original.length + 1);
    expect(input.format).toEqual(inputs[0]!.format);
    expect(
      messages.find(isCapabilityBriefMessage)?.content ?? "",
    ).not.toContain(fixture.entries[0]!.summary);
  }
  expect(nonBrief(modelMessages(inputs[1]!)).at(-1)).not.toEqual(
    nonBrief(modelMessages(inputs[2]!)).at(-1),
  );
});

test("ordinary no-catalog structured repair never introduces a capability brief", async () => {
  const fixture = createPlannerBriefFixture({ entries: [] });
  fixture.invoke.mockImplementation(async () => ({
    text:
      fixture.invoke.mock.calls.length === 1
        ? "invalid"
        : JSON.stringify({
            decision: {
              action: "return_result",
              result: "Knowledge-only result.",
            },
          }),
    meta: {},
  }));
  await expect(
    runPlannerDecision(fixture.request, fixture.inputOptions),
  ).resolves.toMatchObject({ action: "return_result" });
  expect(fixture.invoke).toHaveBeenCalledTimes(2);
  for (const [input] of fixture.invoke.mock.calls)
    expect(modelMessages(input).some(isCapabilityBriefMessage)).toBe(false);
});

test("configured methodology and calibration fit without duplicate admission or root steering", async () => {
  const fixture = createPlannerBriefFixture({
    methodology: "METHOD_MARK ".repeat(40),
    calibration: "CALIBRATION_MARK ".repeat(40),
  });
  fixture.steering.append({
    steerId: "unrelated-root-update",
    text: "ROOT_STEERING_MARK ".repeat(2000),
  });
  await runPlannerDecision(fixture.request, fixture.inputOptions);
  expect(fixture.invoke).toHaveBeenCalledTimes(1);
  const messages = modelMessages(fixture.invoke.mock.calls[0]![0]);
  const serialized = JSON.stringify(messages);
  expect(serialized.match(/METHOD_MARK/g)).toHaveLength(40);
  const calibration = buildPlannerCapabilityBriefOptions(
    fixture.request,
    fixture.input.availableWorkerCapabilityCatalog,
  ).additionalBudgetMessages;
  expect(JSON.stringify(calibration).match(/CALIBRATION_MARK/g)).toHaveLength(
    40,
  );
  expect(serialized).not.toContain("CALIBRATION_MARK");
  expect(serialized).not.toContain("ROOT_STEERING_MARK");
  expect(messages.filter(isCapabilityBriefMessage)).toHaveLength(1);
});
