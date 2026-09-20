import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { isCapabilityBriefMessage } from "../context/capability-brief.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createReadmissionFixture } from "./support/supervisor-brief-readmission-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function withoutBrief(messages: readonly ChatMessage[]) {
  return messages.filter((message) => !isCapabilityBriefMessage(message));
}

test("does not introduce an initially absent brief even when the catalog fits", () => {
  const fixture = createReadmissionFixture();
  const projected = withoutBrief(fixture.messages);
  fixture.project.mockReturnValue(projected);
  const result = fixture.wrapped.project(projected);
  expect(result).toBe(projected);
  expect(result.some(isCapabilityBriefMessage)).toBe(false);
  expect(fixture.prepare).not.toHaveBeenCalled();
  expect(fixture.gateway.invoke).not.toHaveBeenCalled();
});

test("ample headroom preserves the exact projected array and every message and schema", () => {
  const fixture = createReadmissionFixture();
  fixture.project.mockReturnValue(fixture.messages);
  const before = structuredClone({
    messages: fixture.messages,
    input: fixture.input,
  });
  const result = fixture.wrapped.project(fixture.messages);
  expect(result).toBe(fixture.messages);
  expect(fixture.project).toHaveBeenCalledExactlyOnceWith(fixture.messages);
  expect({ messages: fixture.messages, input: fixture.input }).toEqual(before);
  expect(result[3]).toBe(fixture.brief);
});

test("repair growth yields only the optional brief and preserves exact history, intent and repair evidence", () => {
  const fixture = createReadmissionFixture({ contextWindowTokens: 8000 });
  const mandatory = fixture.assess(withoutBrief(fixture.messages));
  const repair: ChatMessage = {
    role: "user",
    content:
      "Repair this invalid output: " +
      "r".repeat(
        mandatory.compactionTriggerInputTokens -
          mandatory.estimatedInputTokens -
          300,
      ),
  };
  const messages = [...fixture.messages, repair];
  const before = structuredClone({ messages, input: fixture.input });
  const result = fixture.wrapped.project(messages);
  expect(fixture.assess(messages).estimatedInputTokens).toBeGreaterThanOrEqual(
    mandatory.compactionTriggerInputTokens,
  );
  expect(result).not.toEqual(messages);
  expect(withoutBrief(result)).toEqual(withoutBrief(messages));
  for (const message of withoutBrief(messages))
    expect(result).toContain(message);
  expect(result.at(-1)).toBe(repair);
  expect(fixture.assess(result).estimatedInputTokens).toBeLessThan(
    mandatory.compactionTriggerInputTokens,
  );
  expect({ messages, input: fixture.input }).toEqual(before);
});

test("assesses the latest base projection and preserves the replacement brief position", () => {
  const fixture = createReadmissionFixture({ contextWindowTokens: 8000 });
  const mandatory = fixture.assess(withoutBrief(fixture.messages));
  const projected = [
    ...fixture.messages,
    {
      role: "assistant" as const,
      content: "p".repeat(
        mandatory.compactionTriggerInputTokens -
          mandatory.estimatedInputTokens -
          500,
      ),
    },
  ];
  fixture.project.mockReturnValue(projected);
  const result = fixture.wrapped.project(fixture.messages);
  expect(fixture.project).toHaveBeenCalledExactlyOnceWith(fixture.messages);
  expect(withoutBrief(result)).toEqual(withoutBrief(projected));
  expect(result.findIndex(isCapabilityBriefMessage)).toBe(3);
  expect(result[3]!.content).not.toBe(fixture.brief.content);
  expect(fixture.assess(result).estimatedInputTokens).toBeLessThan(
    mandatory.compactionTriggerInputTokens,
  );
});

test("delegates prepare receipts and observes the controller's live compaction scope", async () => {
  const fixture = createReadmissionFixture();
  expect(fixture.wrapped.compactionScope).toBe("session_history");
  const result = await fixture.wrapped.prepare(fixture.messages);
  expect(result).toBe(fixture.receipt);
  expect(fixture.prepare).toHaveBeenCalledExactlyOnceWith(fixture.messages);
  expect(fixture.project).not.toHaveBeenCalled();
  await result.commit();
  expect(fixture.wrapped.compactionScope).toBe("active_request");
  expect(fixture.receipt.commit).toHaveBeenCalledOnce();
});

test("configured methodology already in the messages is counted once", () => {
  const methodology = "m".repeat(1600);
  const ample = createReadmissionFixture({ methodology });
  const total = ample.assess(ample.messages).estimatedInputTokens;
  const fixture = createReadmissionFixture({
    methodology,
    contextWindowTokens: Math.ceil((total + 100) / 0.7),
  });
  fixture.project.mockReturnValue(fixture.messages);
  expect(fixture.wrapped.project(fixture.messages)).toBe(fixture.messages);
  expect(fixture.assess(fixture.messages).estimatedInputTokens).toBeLessThan(
    fixture.assess(fixture.messages).compactionTriggerInputTokens,
  );
});

test.each(["calibration", "steering"] as const)(
  "counts current %s without appending it or altering existing messages",
  (kind) => {
    const ample = createReadmissionFixture();
    const total = ample.assess(ample.messages).estimatedInputTokens;
    const contextWindowTokens = Math.ceil((total + 100) / 0.7);
    const fixture = createReadmissionFixture({
      contextWindowTokens,
      ...(kind === "calibration" ? { calibration: "c".repeat(1500) } : {}),
    });
    if (kind === "steering") {
      expect(fixture.wrapped.project(fixture.messages)).toEqual(
        fixture.messages,
      );
      expect(
        fixture.steering.append({
          steerId: "new-guidance",
          text: "s".repeat(1500),
        }).ok,
      ).toBe(true);
    }
    const before = structuredClone(fixture.messages);
    const result = fixture.wrapped.project(fixture.messages);
    expect(result).not.toEqual(fixture.messages);
    expect(withoutBrief(result)).toEqual(withoutBrief(fixture.messages));
    expect(fixture.messages).toEqual(before);
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.gateway.invoke).not.toHaveBeenCalled();
  },
);
