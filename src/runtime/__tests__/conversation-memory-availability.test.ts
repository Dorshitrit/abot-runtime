import { describe, expect, test } from "vitest";
import { runRequestRunner } from "../request/runner.js";
import { createMemoryRecallHarness, modelMessages, responseDecision, type RecallPolicy } from "./support/memory-recall-runner.js";
import { deriveTestRequestExecutionScope } from "./support/request-execution-scope.js";

const POLICIES: readonly RecallPolicy[] = ["supervisor-worker-v1", "execution-agent-v1"];

async function runAvailabilityCase(policy: RecallPolicy, enabled: boolean, prompt: string) {
  let memoryReadsAtDecision = -1;
  const f = createMemoryRecallHarness({
    policy, enabled, memoryRecallLimit: 0,
    decide: () => {
      memoryReadsAtDecision = f.memory.retrieve.mock.calls.length;
      return { ...responseDecision(policy), acknowledgement: "I will answer." };
    },
  });
  const request = deriveTestRequestExecutionScope(f.request, { prompt });
  const result = await runRequestRunner(request);
  const decisions = f.invoke.mock.calls.map(([input]) => input)
    .filter(({ modelStep }) => modelStep?.endsWith(".decision"));
  return { ...f, result, decisions, memoryReadsAtDecision };
}

describe("core passive memory availability at root decisions", () => {
  test.each(POLICIES)("%s projects availability without expanding decision actions or starting memory work", async (policy) => {
    const prompt = "Please remember that I am interested in AI models.";
    const enabled = await runAvailabilityCase(policy, true, prompt);
    const disabled = await runAvailabilityCase(policy, false, prompt);
    expect(enabled.decisions).toHaveLength(1);
    expect(disabled.decisions).toHaveLength(1);
    expect(enabled.decisions[0]!.format).toEqual(disabled.decisions[0]!.format);
    expect(enabled.memoryReadsAtDecision).toBe(0);
    expect(disabled.memoryReadsAtDecision).toBe(0);
    expect(enabled.getAdapters).not.toHaveBeenCalled();
    expect(enabled.memory.processCandidates).not.toHaveBeenCalled();
    expect(enabled.memory.scheduleCandidates).not.toHaveBeenCalled();
    expect(enabled.result.output).toBe(disabled.result.output);
    expect(enabled.result.memoryCandidates).toBeUndefined();
    const expectedEnabledCalls = policy === "supervisor-worker-v1" ? 3 : 2;
    expect(enabled.invoke).toHaveBeenCalledTimes(expectedEnabledCalls);
    expect(disabled.invoke).toHaveBeenCalledTimes(2);

    const enabledMessages = modelMessages(enabled.decisions[0]!);
    const disabledMessages = modelMessages(disabled.decisions[0]!);
    expect(enabledMessages[0]!.role).toBe("system");
    expect(enabledMessages[0]!.content).not.toBe(disabledMessages[0]!.content);
    expect(enabledMessages.slice(1)).toEqual(disabledMessages.slice(1));
    for (const messages of [enabledMessages, disabledMessages]) {
      expect(messages.filter(({ role, content }) => role === "user" && content === prompt)).toHaveLength(1);
    }
  });

  test.each(POLICIES)("%s keeps unrelated user intent unchanged and does not route from prompt words", async (policy) => {
    const prompt = "Explain what causes a solar eclipse.";
    const f = await runAvailabilityCase(policy, true, prompt);
    expect(f.decisions).toHaveLength(1);
    const messages = modelMessages(f.decisions[0]!);
    expect(messages.filter(({ role, content }) => role === "user" && content === prompt)).toHaveLength(1);
    expect(messages[0]!.role).toBe("system");
    expect(f.memoryReadsAtDecision).toBe(0);
    expect(f.getAdapters).not.toHaveBeenCalled();
    expect(f.memory.processCandidates).not.toHaveBeenCalled();
    expect(f.result.memoryCandidates).toBeUndefined();
  });
});
