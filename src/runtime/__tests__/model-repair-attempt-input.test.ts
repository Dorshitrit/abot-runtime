import { expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { buildOpenAIResponsesPayload } from "../../model-gateway/providers/openai/payload.js";
import { invokeRepairableRawModelStep } from "../model/invoke-raw-step.js";
import { invokeStructuredModelStep } from "../model/invoke-structured-step.js";
import { buildModelRepairAttemptMessages } from "../model/repair-prompts.js";
import { createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";
import { executionPrefixCachePolicy } from "./support/execution-prefix-cache-fixture.js";

test.each(["structured", "raw"] as const)(
  "%s repair uses the current validation issue over the same ordered evidence and steering",
  async (mode) => {
    const modelStep = mode === "structured" ? "supervisor.decision" : "supervisor.response";
    const fixture = await createControlsEvidenceFixture({
      runnerConfig: {
        models: { defaults: { profileId: "test", steps: { [modelStep]: modelStep } } },
        context: { outputReserveTokens: 1000, safetyReserveTokens: 200, attachmentReserveTokens: 100 },
        steps: { [modelStep]: { timeoutMs: 20000 } },
      },
    });
    fixture.steering.append({ steerId: "steer-1", text: "latest direction" });
    fixture.invoke
      .mockResolvedValueOnce({ text: "discarded-first", meta: {} })
      .mockResolvedValueOnce({ text: "discarded-second", meta: {} })
      .mockResolvedValueOnce({ text: "accepted", meta: {} });
    const messages: ChatMessage[] = [
      { role: "system", content: "step policy" },
      { role: "system", content: "scoped context" },
      { role: "user", content: "original request" },
      { role: "assistant", content: "", toolCalls: [{ name: "lookup", callId: "id", arguments: "{}" }] },
      { role: "tool", content: "settled evidence", toolCallId: "id", toolName: "lookup" },
      { role: "system", content: "original instruction after the evidence" },
    ];
    const params = { request: fixture.request, modelStep, messages, timeoutReason: "test_timeout" } as const;
    const invalid = (text: string) => ({
      ok: false as const, stage: "validation", reason: "invalid",
      issues: [{ path: "result", message: "Correct the field.", code: text === "discarded-first" ? "issue_a" : "issue_b" }],
    });
    const result = mode === "structured"
      ? await invokeStructuredModelStep({
          ...params, invalidOutputReason: "invalid",
          format: { type: "json_schema", name: "test", schema: { type: "object", properties: {} } },
          parse: (text) => text === "accepted" ? { ok: true, decision: text } : invalid(text),
        })
      : await invokeRepairableRawModelStep({
          ...params, maxRepairAttempts: 2,
          validate: (text) => text === "accepted" ? { ok: true, value: text } : invalid(text),
          buildRepairHint: ({ issues }) => issues.map(({ code }) => code).join("\n"),
        });

    expect(result).toBe("accepted");
    const attempts = fixture.invoke.mock.calls.map(([input]) => input.messages as ChatMessage[]);
    expect(attempts).toHaveLength(3);
    const [first, ...repairs] = attempts;
    expect(first!.slice(0, -1)).toEqual(messages);
    expect(first!.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("latest direction") });
    expect(fixture.countInputTokens.mock.calls.map(([input]) => input.messages)).toEqual(attempts);
    for (const [index, repair] of repairs.entries()) {
      expect(repair.slice(0, 2)).toEqual(first!.slice(0, 2));
      expect(repair.slice(3)).toEqual(first!.slice(2));
      const guidance = repair[2]!;
      expect(guidance.role).toBe("system");
      expect(guidance.content).toContain(index === 0 ? "issue_a" : "issue_b");
      expect(guidance.content).not.toContain(index === 0 ? "issue_b" : "issue_a");
      expect(JSON.stringify(repair)).not.toContain("discarded-");
    }
  },
);

test("cache-bound structured repairs preserve the complete original provider prefix and only the latest hint", async () => {
  const fixture = await createControlsEvidenceFixture({ modelPolicy: executionPrefixCachePolicy });
  fixture.invoke
    .mockResolvedValueOnce({ text: "discarded-first", meta: {} })
    .mockResolvedValueOnce({ text: "discarded-second", meta: {} })
    .mockResolvedValueOnce({ text: "accepted", meta: {} });
  const activation: ChatMessage = { role: "user", content: "Current activation" };
  const messages: ChatMessage[] = [
    { role: "system", content: "Stable step policy" },
    { role: "user", content: "Original request" },
    { role: "assistant", content: "", toolCalls: [{ name: "lookup", callId: "id", arguments: "{}" }] },
    { role: "tool", content: "Settled evidence", toolCallId: "id", toolName: "lookup" },
    activation,
  ];
  const before = JSON.stringify(messages);
  const result = await invokeStructuredModelStep({
    request: fixture.request, modelStep: "execution.decision", messages,
    promptCacheBoundaryBeforeMessage: activation,
    contextRetention: "exact", timeoutReason: "fixture_timeout", invalidOutputReason: "fixture_invalid",
    format: { type: "json_schema", name: "fixture", strict: true,
      schema: { type: "object", properties: { decision: { type: "string" } }, required: ["decision"], additionalProperties: false } },
    parse: (text) => text === "accepted" ? { ok: true, decision: text } : {
      ok: false, stage: "fixture", issues: [{ path: "decision", message: "Correct the field.",
        code: text === "discarded-first" ? "issue_a" : "issue_b" }],
    },
  });
  expect(result).toBe("accepted");
  const attempts = fixture.invoke.mock.calls.map(([input]) => input);
  const payloads = attempts.map((input) => buildOpenAIResponsesPayload(input));
  const initialInput = payloads[0]!.input as unknown[];
  expect(attempts).toHaveLength(3);
  expect(payloads[0]!.tools).toHaveLength(1);
  expect(typeof payloads[0]!.prompt_cache_key).toBe("string");
  expect(attempts.map((input) => input.promptCacheBoundaryBeforeMessageIndex)).toEqual([4, 4, 4]);
  expect(fixture.countInputTokens.mock.calls.map(([input]) => input.messages)).toEqual(attempts.map((input) => input.messages));
  for (const [index, payload] of payloads.slice(1).entries()) {
    const input = payload.input as unknown[];
    expect(JSON.stringify(input.slice(0, initialInput.length))).toBe(JSON.stringify(initialInput));
    expect(payload.tools).toEqual(payloads[0]!.tools);
    expect(payload.prompt_cache_key).toBe(payloads[0]!.prompt_cache_key);
    expect(payload.prompt_cache_options).toEqual(payloads[0]!.prompt_cache_options);
    const repaired = attempts[index + 1]!.messages as ChatMessage[];
    expect(repaired.slice(0, -1)).toEqual(messages);
    expect(repaired.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining(index === 0 ? "issue_a" : "issue_b") });
    expect(repaired.at(-1)!.content).not.toContain(index === 0 ? "issue_b" : "issue_a");
    expect(JSON.stringify(repaired)).not.toContain("discarded-");
  }
  expect(JSON.stringify(messages)).toBe(before);
});

test("missing, copied or ambiguous cache anchors retain legacy repair ordering", () => {
  const instructions: ChatMessage = { role: "system", content: "Policy" };
  const activation: ChatMessage = { role: "user", content: "Current activation" };
  const absent: ChatMessage = { role: "user", content: "Absent anchor" };
  for (const boundary of [undefined, { ...activation }, absent, instructions]) {
    expect(buildModelRepairAttemptMessages([instructions, activation], "Repair", boundary)).toEqual([
      instructions, { role: "system", content: "Repair" }, activation,
    ]);
  }
  expect(buildModelRepairAttemptMessages([instructions, activation, activation], "Repair", activation)).toEqual([
    instructions, { role: "system", content: "Repair" }, activation, activation,
  ]);
});
