import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { projectRolePresentationEvent } from "../events/role-presentation.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { createFailureHarness } from "./support/super-handler-failure-fixture.js";

vi.mock("../request/runner.js", () => ({
  runRequestRunner: vi.fn(async (request: RequestExecutionScope, options?: { durableApproval?: boolean }) => {
    request.onEvent("runtime.state", { stage: "supervisor", phase: "working", message: "Processing" });
    request.onEvent("tool.started", { executorRole: "supervisor", executionId: "tool-1", tool: "inspect_target" });
    request.onEvent("runtime.state", { stage: "reviewer", phase: "reviewing", message: "Reviewing" });
    request.onEvent("runtime.state", { stage: "planner", phase: "working", message: "Planning" });
    const result = { output: "Done." };
    return options?.durableApproval ? { kind: "completed", result } : result;
  }),
}));

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

describe("frozen execution policy role presentation", () => {
  test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
    "%s records the same canonical identity and presentation for live and replay",
    async (policy) => {
      const h = await createFailureHarness(policy);
      await h.run(vi.fn());
      const live = h.events.filter((event) => event.stage === "supervisor" || event.stage === "reviewer" || event.stage === "planner" || event.name === "tool.started");
      const replay = await h.sessionStore.getRequestReplayById("failure-request");
      const stored = replay!.events.filter((event) => event.stage === "supervisor" || event.stage === "reviewer" || event.stage === "planner" || event.name === "tool.started");
      expect(live).toHaveLength(4);
      expect(stored.map(({ name, stage, executorRole, presentationRole }) => ({ name, stage, executorRole, presentationRole })))
        .toEqual(live.map(({ name, stage, executorRole, presentationRole }) => ({ name, stage, executorRole, presentationRole })));
      expect(live.map((event) => event.stage || event.executorRole)).toEqual(["supervisor", "supervisor", "reviewer", "planner"]);
      if (policy === "execution-agent-v1") {
        expect(live.map((event) => event.presentationRole)).toEqual(["execution_agent", "execution_agent", "auditor", undefined]);
      } else {
        expect(live.every((event) => !Object.hasOwn(event, "presentationRole"))).toBe(true);
      }
    },
  );

  test("only the explicit frozen root contract decorates supported role-bearing events", () => {
    const payload = { stage: "supervisor", phase: "working", selectedProfile: "ea" };
    expect(projectRolePresentationEvent("supervisor", "runtime.state", payload)).toBe(payload);
    expect(projectRolePresentationEvent("execution_agent", "model.step", payload)).toBe(payload);
    const worker = { stage: "worker" };
    expect(projectRolePresentationEvent("execution_agent", "runtime.state", worker)).toBe(worker);
    expect(projectRolePresentationEvent("execution_agent", "runtime.state", undefined)).toBeUndefined();
    expect(projectRolePresentationEvent("execution_agent", "runtime.state", payload))
      .toEqual({ ...payload, presentationRole: "execution_agent" });
    expect(payload).not.toHaveProperty("presentationRole");
  });
});
