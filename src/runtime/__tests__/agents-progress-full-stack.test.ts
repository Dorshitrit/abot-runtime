import { expect, test, vi } from "vitest";
import { createAgentChatUpdates } from "../../web-ui/local-runtime/agent-chat-updates.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { agentFullStackFixture } from "./support/agents-full-stack-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)("selected Agent chat reads %s public progress while the same request is running", async (policy) => {
  const f = await agentFullStackFixture(policy, true);
  const ordinaryModel = f.ordinary.invoke.getMockImplementation()!;
  let emitted = false, reachedSecondStep = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const text = "I checked the available actions and will ask before changing the fixture.";
  f.ordinary.invoke.mockImplementation(async (input) => {
    if (emitted && (policy === "execution-agent-v1" || input.modelStep?.startsWith("worker."))) { reachedSecondStep = true; await gate; }
    const result = await ordinaryModel(input);
    if (!emitted && (input.modelStep === "execution.decision" || input.modelStep === "supervisor.decision")) {
      const body = JSON.parse(result.text);
      if (policy === "execution-agent-v1" && body.decision.action === "open_capability_scope") {
        body.decision.interaction = { kind: "message", text }; emitted = true;
        return { ...result, text: JSON.stringify(body) };
      }
      if (policy === "supervisor-worker-v1" && body.decision.acknowledgement) {
        body.decision.acknowledgement = text; emitted = true;
        return { ...result, text: JSON.stringify(body) };
      }
    }
    return result;
  });
  try {
    await f.app.send("agent-a", { messageId: "user-task", text: "Perform the fictional mutation after approval.", intent: "task" });
    await vi.waitFor(() => expect(reachedSecondStep).toBe(true), { timeout: 8000 });
    const detail = await f.app.detail("agent-a"); const state = await f.source.store.read();
    expect(detail.attempts[0]?.status).toBe("claimed");
    const invocations = f.ordinary.invoke.mock.calls.length, management = f.source.invoke.mock.calls.length;
    const project = createAgentChatUpdates(f.ordinary.sessions);
    await vi.waitFor(async () => expect(await project(detail, state)).toContainEqual(expect.objectContaining({ missionId: detail.mission!.id, text })), { timeout: 5000 });
    const projected = await createAgentChatUpdates(f.ordinary.sessions)(detail, state);
    expect(projected.filter((entry) => entry.text === text)).toHaveLength(1);
    expect(await f.source.store.read()).toEqual(state);
    expect(f.ordinary.invoke).toHaveBeenCalledTimes(invocations); expect(f.source.invoke).toHaveBeenCalledTimes(management);
    release(); await f.app.whenIdle(); expect((await f.app.detail("agent-a")).status).toBe("awaiting_approval");
  } finally { release(); await f.dispose(); await disposeCompositionFixtures(); resetDebugLoggerConfig(); }
}, 18_000);
