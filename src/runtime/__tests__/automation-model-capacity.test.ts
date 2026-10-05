import { expect, test, vi } from "vitest";
import type { ModelGatewayPolicyConfig } from "../../model-gateway/types.js";
import type { ModelGatewayRawInvokeParams } from "../ports.js";
import { createAutomationModelCapacity } from "../automations/model-capacity.js";

const policy: ModelGatewayPolicyConfig = {
  providers: {
    local: { type: "ollama" },
    secondLocal: { type: "ollama" },
    cloud: { type: "openai" },
  },
  profiles: {
    localA: { provider: "local", model: "a", contextWindowTokens: 8_192 },
    localB: { provider: "local", model: "b", contextWindowTokens: 8_192 },
    secondLocal: { provider: "secondLocal", model: "c", contextWindowTokens: 8_192 },
    cloud: { provider: "cloud", model: "d", contextWindowTokens: 8_192 },
  },
  defaults: { profileId: "localA" },
};

function params(profileId: string, signal = new AbortController().signal): ModelGatewayRawInvokeParams {
  return {
    prompt: "Run one step", agentMode: "fast",
    modelPreference: { profileId, scope: "all" }, abortSignal: signal,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("serializes Agent model calls by Ollama provider instance before budget debit", async () => {
  const capacity = createAutomationModelCapacity();
  const firstDone = deferred<string>();
  const calls: string[] = [];
  const first = capacity.withInvocation(params("localA"), policy, async () => {
    calls.push("debit first");
    return firstDone.promise;
  });
  const second = capacity.withInvocation(params("localB"), policy, async () => {
    calls.push("debit second");
    return "second";
  });
  await Promise.resolve();
  expect(calls).toEqual(["debit first"]);
  firstDone.resolve("first");
  expect(await first).toBe("first");
  expect(await second).toBe("second");
  expect(calls).toEqual(["debit first", "debit second"]);
});

test("waiting cancellation removes the call without budget debit", async () => {
  const capacity = createAutomationModelCapacity();
  const firstDone = deferred<string>();
  const first = capacity.withInvocation(params("localA"), policy, () => firstDone.promise);
  const waitingAbort = new AbortController();
  const invoke = vi.fn(async () => "unexpected");
  const waiting = capacity.withInvocation(params("localB", waitingAbort.signal), policy, invoke);
  waitingAbort.abort(new Error("stopped"));
  await expect(waiting).rejects.toThrow("stopped");
  expect(invoke).not.toHaveBeenCalled();
  firstDone.resolve("first");
  await first;
  expect(await capacity.withInvocation(params("localB"), policy, async () => "next"))
    .toBe("next");
});

test("different Ollama instances and cloud calls are not serialized together", async () => {
  const capacity = createAutomationModelCapacity();
  const firstDone = deferred<string>();
  const calls: string[] = [];
  const first = capacity.withInvocation(params("localA"), policy, () => {
    calls.push("local");
    return firstDone.promise;
  });
  const otherLocal = capacity.withInvocation(params("secondLocal"), policy, async () => {
    calls.push("other local");
    return "other";
  });
  const cloud = capacity.withInvocation(params("cloud"), policy, async () => {
    calls.push("cloud");
    return "cloud";
  });
  expect(await otherLocal).toBe("other");
  expect(await cloud).toBe("cloud");
  expect(calls).toHaveLength(3);
  expect(calls).toEqual(expect.arrayContaining(["local", "other local", "cloud"]));
  firstDone.resolve("first");
  await first;
});

test("a failed invocation releases its provider slot", async () => {
  const capacity = createAutomationModelCapacity();
  const failure = deferred<string>();
  const first = capacity.withInvocation(params("localA"), policy, () => failure.promise);
  const second = capacity.withInvocation(params("localB"), policy, async () => "next");
  failure.reject(new Error("provider failed"));
  await expect(first).rejects.toThrow("provider failed");
  await expect(second).resolves.toBe("next");
});
