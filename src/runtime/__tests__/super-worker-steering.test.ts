import { describe, expect, test, vi } from "vitest";
import type { ModelGatewayClient } from "../ports.js";
import { ModelGatewayInvocationError } from "../../model-gateway/client/invocation-error.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { isRequestExecutionScope } from "../request/execution-scope.js";
import { bindSuperWorkerSteering, projectSuperWorkerDelegationSteering } from "../request/super-worker-steering.js";
import { bindSuperWorkerSteeringExecutor } from "../request/super-worker-steering-executor.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { createRequestCancellationError } from "../request/cancellation.js";
import { createRoleExecutorRegistry, type RoleExecutor } from "../orchestration/role-executors/index.js";
import { normalizeRoleExecutorActivationResult } from "../orchestration/role-executors/activation/result-normalization.js";
import { rebindTestRequestExecutionPolicy } from "./support/request-execution-scope.js";
import {
  createSuperWorkerSteeringFixture,
  settleSteeringFixtureObservation,
} from "./support/super-worker-steering-fixture.js";

describe("SUPER Worker yields to its exact caller", () => {
  test.each(["supervisor", "planner"] as const)("discards stale model output before effects and returns to %s", async (caller) => {
    let finish: ((value: { text: string; meta: Record<string, unknown> }) => void) | undefined;
    const pending = new Promise<{ text: string; meta: Record<string, unknown> }>((resolve) => { finish = resolve; });
    const invoke = vi.fn<ModelGatewayClient["invoke"]>(async () => pending);
    const fixture = await createSuperWorkerSteeringFixture(caller, invoke);
    const effect = vi.fn();
    const execute = vi.fn<RoleExecutor<RequestExecutionScope>["execute"]>(async ({ context }) => {
      await context.modelSteps.invoke({
        modelStep: "worker.decision", messages: [{ role: "system", content: "Choose only from the assignment." }],
        timeoutReason: "fixture_timeout", accept: (text) => text,
      });
      effect();
      return { kind: "terminal", outcome: "completed", summary: "Finished." };
    });
    const registry = createRoleExecutorRegistry([bindSuperWorkerSteeringExecutor({ roleId: "worker", execute })]);
    const resultPromise = registry.invokeChild({
      requestId: fixture.request.requestId, context: fixture.request, callerCall: fixture.callerCall,
      ledger: fixture.ledger, expectedHead: fixture.ledger.current(), roleId: "worker",
      ...fixture.workerInvocation, workerSteeringVersion: 0, turnCount: 1,
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    fixture.steering.append({ steerId: "new-direction", text: "Stop the current work." });
    finish!({ text: "stale action", meta: {} });
    const result = await resultPromise;
    expect(result.execution).toMatchObject({ outcome: "yielded", steeringVersion: 1 });
    expect(result.returnCommit.effect).toMatchObject({ callerCallId: fixture.callerCall.callId });
    expect(fixture.ledger.current().state.activeCallId).toBe(fixture.callerCall.callId);
    expect(effect).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(invoke.mock.calls[0]![0].messages)).not.toContain("Stop the current work.");
  });

  test("retains settled effects and yields before another Worker activation", async () => {
    const fixture = await createSuperWorkerSteeringFixture("planner");
    const execute = vi.fn<RoleExecutor<RequestExecutionScope>["execute"]>(async ({ call, ledger }) => {
      const executionId = await settleSteeringFixtureObservation(ledger, call);
      fixture.steering.append({ steerId: "stop-after-receipt", text: "That is enough." });
      return { kind: "continue", continuation: { kind: "capability_execution", executionId } };
    });
    const registry = createRoleExecutorRegistry([bindSuperWorkerSteeringExecutor({ roleId: "worker", execute })]);
    const result = await registry.invokeChild({
      requestId: fixture.request.requestId, context: fixture.request, callerCall: fixture.callerCall,
      ledger: fixture.ledger, expectedHead: fixture.ledger.current(), roleId: "worker",
      ...fixture.workerInvocation, workerSteeringVersion: 0, turnCount: 1,
    });
    expect(result.execution).toMatchObject({ outcome: "yielded", steeringVersion: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fixture.ledger.current().state.capabilityExecutions).toHaveLength(1);
    expect(fixture.ledger.current().state.capabilityExecutions[0]).toMatchObject({
      outcome: "succeeded", summary: "Observation retained.",
    });
  });

  test("a failed in-flight model call still delivers new steering to the Planner", async () => {
    const fixture = await createSuperWorkerSteeringFixture("planner", vi.fn(async () => {
      fixture.steering.append({ steerId: "change-during-failure", text: "Change the current work." });
      throw new ModelGatewayInvocationError("network", "provider unavailable");
    }));
    const executor: RoleExecutor<RequestExecutionScope> = {
      roleId: "worker",
      async execute({ context }) {
        await context.modelSteps.invoke({
          modelStep: "worker.decision", messages: [{ role: "system", content: "Follow the assignment." }],
          timeoutReason: "fixture_timeout", accept: (text) => text,
        });
        return { kind: "terminal", outcome: "completed", summary: "Finished." };
      },
    };
    const registry = createRoleExecutorRegistry([bindSuperWorkerSteeringExecutor(executor)]);
    const result = await registry.invokeChild({
      requestId: fixture.request.requestId, context: fixture.request, callerCall: fixture.callerCall,
      ledger: fixture.ledger, expectedHead: fixture.ledger.current(), roleId: "worker",
      ...fixture.workerInvocation, workerSteeringVersion: 0, turnCount: 1,
    });
    expect(result.execution).toMatchObject({ outcome: "yielded", steeringVersion: 1 });
    expect(result.returnCommit.effect).toMatchObject({ callerCallId: fixture.callerCall.callId });
  });

  test("preserves ordinary Worker output and request facets without new steering", async () => {
    const fixture = await createSuperWorkerSteeringFixture();
    const execute = vi.fn<RoleExecutor<RequestExecutionScope>["execute"]>(async ({ context }) => {
      expect(isRequestExecutionScope(context)).toBe(true);
      expect(context.identity).toBe(fixture.request.identity);
      expect(context.lifecycle).toBe(fixture.request.lifecycle);
      expect(context.workerCapabilities.provider).toBe(fixture.request.workerCapabilities.provider);
      expect(context.workerCapabilities.executionContext.modelSteps).toBe(context.modelSteps);
      return { kind: "terminal", outcome: "completed", summary: "Ordinary result." };
    });
    const registry = createRoleExecutorRegistry([bindSuperWorkerSteeringExecutor({ roleId: "worker", execute })]);
    const result = await registry.invokeChild({
      requestId: fixture.request.requestId, context: fixture.request, callerCall: fixture.callerCall,
      ledger: fixture.ledger, expectedHead: fixture.ledger.current(), roleId: "worker",
      ...fixture.workerInvocation, workerSteeringVersion: 0, turnCount: 1,
    });
    expect(result.execution).toEqual({ kind: "terminal", outcome: "completed", summary: "Ordinary result." });
  });

  test("cancellation remains terminal and takes priority over steering", async () => {
    const fixture = await createSuperWorkerSteeringFixture();
    fixture.steering.append({ steerId: "later", text: "Change the direction." });
    fixture.abort.abort(createRequestCancellationError());
    const execute = vi.fn<RoleExecutor<RequestExecutionScope>["execute"]>();
    const registry = createRoleExecutorRegistry([bindSuperWorkerSteeringExecutor({ roleId: "worker", execute })]);
    await expect(registry.invokeChild({
      requestId: fixture.request.requestId, context: fixture.request, callerCall: fixture.callerCall,
      ledger: fixture.ledger, expectedHead: fixture.ledger.current(), roleId: "worker",
      ...fixture.workerInvocation, workerSteeringVersion: 0, turnCount: 1,
    })).rejects.toThrow("request_cancelled");
    expect(execute).not.toHaveBeenCalled();
  });

  test("cannot manufacture a yielded work result through ordinary executor output", () => {
    expect(normalizeRoleExecutorActivationResult({
      kind: "terminal", outcome: "yielded", steeringVersion: 1, summary: "Claimed yield.",
    }, 1_000)).toMatchObject({ ok: false, issueCode: "terminal_shape_invalid" });
  });

  test("production SUPER composition yields a stale Worker before invoking a model", async () => {
    const invoke = vi.fn<ModelGatewayClient["invoke"]>();
    const fixture = await createSuperWorkerSteeringFixture("supervisor", invoke);
    fixture.steering.append({ steerId: "stop-before-start", text: "Stop." });
    const result = await fixture.request.executionPolicy.roleExecutors.invokeChild({
      requestId: fixture.request.requestId, context: fixture.request, callerCall: fixture.callerCall,
      ledger: fixture.ledger, expectedHead: fixture.ledger.current(), roleId: "worker",
      ...fixture.workerInvocation, workerSteeringVersion: 0, turnCount: 1,
    });
    expect(result.execution).toMatchObject({ outcome: "yielded", steeringVersion: 1 });
    expect(invoke).not.toHaveBeenCalled();
  });

  test("leaves EA and non-Worker role binding unchanged", async () => {
    const fixture = await createSuperWorkerSteeringFixture();
    const ea = rebindTestRequestExecutionPolicy(fixture.request, resolveRequestExecutionPolicy("execution-agent-v1"));
    const worker = { ...fixture.callerCall, roleId: "worker" as const };
    expect(bindSuperWorkerSteering(ea, worker)).toBe(ea);
    expect(bindSuperWorkerSteering(fixture.request, fixture.callerCall)).toBe(fixture.request);
    expect(projectSuperWorkerDelegationSteering(ea, "worker", 3)).toEqual({});
    expect(projectSuperWorkerDelegationSteering(fixture.request, "planner", 3)).toEqual({});
    expect(projectSuperWorkerDelegationSteering(fixture.request, "worker", 3)).toEqual({ workerSteeringVersion: 3 });
  });
});
