import { expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { invokeRepairableRawModelStep } from "../model/invoke-raw-step.js";
import { invokeStructuredModelStep } from "../model/invoke-structured-step.js";
import { createControlsEvidenceFixture } from "./support/execution-controls-evidence-fixture.js";

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
