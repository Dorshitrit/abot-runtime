import { expect, test, vi } from "vitest";
import { createAutomationToolLifetimes } from "../automations/tool-lifetimes.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test.each(["resolve", "reject"] as const)(
  "drain retains a noncooperative Tool registry promise until it can %s",
  async (settlement) => {
    const lifetimes = createAutomationToolLifetimes();
    const signal = new AbortController();
    const tool = deferred<string>();
    const invoke = vi.fn(() => tool.promise);
    const pending = lifetimes.runInvocation("run", signal.signal, invoke);
    const observedResult = pending.catch((error: unknown) => error);
    signal.abort(new Error("automation_run_stopped"));
    let drained = false;
    const drain = lifetimes.whenSettled("run").then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    if (settlement === "resolve") tool.resolve("finished");
    if (settlement === "reject") tool.reject(new Error("tool_failed"));
    await observedResult;
    await drain;
    expect(drained).toBe(true);
    expect(invoke).toHaveBeenCalledOnce();
    const late = vi.fn(async () => "unexpected");
    await expect(lifetimes.runInvocation("run", signal.signal, late))
      .rejects.toThrow("automation_run_stopped");
    expect(late).not.toHaveBeenCalled();
    expect(await lifetimes.whenSettled("run")).toEqual([]);
  },
);
