import { afterEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { readAgentState } from "../agents/state-validation.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import { agentFullStackFixture } from "./support/agents-full-stack-fixture.js";
const fixtures: Awaited<ReturnType<typeof agentFullStackFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); await disposeCompositionFixtures(); resetDebugLoggerConfig(); });
async function fixture(policy: "execution-agent-v1" | "supervisor-worker-v1", approval = false) {
  const result = await agentFullStackFixture(policy, approval); fixtures.push(result); return result;
}

for (const policy of ["execution-agent-v1", "supervisor-worker-v1"] as const) {
  test(`${policy}: actual Agent application owns a task through the unchanged managed loop and persists its final answer`, async () => {
    const f = await fixture(policy);
    const ordinaryChat = await f.ordinary.sessions.getSessionById("session");
    await f.app.send("agent-a", { messageId: "user-task", text: "Complete and verify the fictional fixture task.", intent: "task" });
    await f.app.whenIdle();
    const detail = await f.app.detail("agent-a"); const state = await f.source.store.read();
    expect(detail.mission?.status).toBe("completed");
    expect(detail.attempts).toHaveLength(1); const attempt = detail.attempts[0]!;
    expect(attempt).toMatchObject({ status: "settled", result: { status: "completed", output: "The scheduled answer preserves the earlier preference." } });
    const session = await f.ordinary.sessions.getSessionById(attempt.request.sessionId);
    const replay = await f.ordinary.sessions.getRequestReplayById(attempt.request.requestId, 0, attempt.request.sessionId);
    expect(replay?.finalState).toMatchObject({ status: "completed", output: attempt.result!.output });
    expect(session?.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([attempt.request.assignment]);
    expect(detail.messages.at(-1)).toMatchObject({ role: "assistant", text: `Agent verified the result: ${attempt.result!.output}` });
    expect(detail.mission?.usage).toMatchObject({ attempts: 1, modelCalls: f.source.invoke.mock.calls.length + f.ordinary.invoke.mock.calls.length,
      totalTokens: f.source.invoke.mock.calls.length * 10 + f.ordinary.invoke.mock.calls.length * 30 });
    expect([...f.source.invoke.mock.calls, ...f.ordinary.invoke.mock.calls].every(([input]) => input.modelPreference?.profileId === "scheduled-model")).toBe(true);
    expect((f.source.invoke.mock.calls.at(-1)![0].messages as ChatMessage[]).some((message) => message.content.includes(String(attempt.result!.output)))).toBe(true);
    expect(f.ordinary.call.mock.calls.filter(([method]) => method === "request.run")).toHaveLength(1);
    expect(await f.ordinary.sessions.getSessionById("session")).toEqual(ordinaryChat);
    expect(readAgentState(state)).toEqual(state);
    await f.app.send("agent-a", { messageId: "user-task", text: "Complete and verify the fictional fixture task.", intent: "task" });
    expect(f.ordinary.call.mock.calls.filter(([method]) => method === "request.run")).toHaveLength(1);
  }, 20_000);

  test(`${policy}: saved approval resumes after Agent restart through the server observer with no browser or redispatch`, async () => {
    const f = await fixture(policy, true);
    await f.app.send("agent-a", { messageId: "approval-task", text: "Perform the fictional mutation after my approval.", intent: "task" });
    await f.app.whenIdle(); const before = await f.app.detail("agent-a");
    expect(before.status).toBe("awaiting_approval"); expect(f.ordinary.execute).not.toHaveBeenCalled();
    const attempt = before.attempts[0]!;
    const restored = await f.restore(); expect((await restored.app.detail("agent-a")).status).toBe("awaiting_approval");
    const [pending] = await f.ordinary.port.listApprovals(attempt.request);
    expect(pending?.wait).toBeDefined();
    expect(await f.ordinary.port.decideApproval(attempt.request, { approvalId: pending!.request.approvalId,
      ...pending!.wait!, approved: true, commandId: "approval-after-restart" })).toEqual({ accepted: true });
    // No refresh route or browser is involved: the running server observer reads ordinary receipts.
    await vi.waitFor(async () => expect((await restored.app.detail("agent-a")).mission?.status).toBe("completed"), { timeout: 8000 });
    await restored.app.whenIdle(); const after = await restored.app.detail("agent-a");
    expect(after.mission?.id).toBe(before.mission?.id); expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]?.result).toMatchObject({ status: "completed", output: "The requested fixture actions settled." });
    expect(after.messages.at(-1)?.text).toBe("Agent verified the result: The requested fixture actions settled.");
    expect(f.ordinary.execute).toHaveBeenCalledOnce();
    expect(f.ordinary.call.mock.calls.filter(([method]) => method === "request.run")).toHaveLength(1);
    expect([...f.source.invoke.mock.calls, ...f.ordinary.invoke.mock.calls].every(([input]) => input.modelPreference?.profileId === "scheduled-model")).toBe(true);
    expect(after.mission?.usage.totalTokens).toBe(f.source.invoke.mock.calls.length * 10 + f.ordinary.invoke.mock.calls.length * 30);
  }, 20_000);
}
