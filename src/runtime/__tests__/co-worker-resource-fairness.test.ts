import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CoWorkerResourceAdmission } from "../passive-learning/resources/admission.js";
import { CoWorkerResourceBudget } from "../passive-learning/resources/budget.js";
import {
  DEFAULT_CO_WORKER_RESOURCE_LIMITS,
  type CoWorkerResourceActivity,
} from "../passive-learning/resources/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const permit = () => {};
function request(
  activity: CoWorkerResourceActivity,
  maximum = () => 1,
  supportsParallel = true,
) {
  return {
    activity,
    maximum,
    supportsParallel,
    signal: new AbortController().signal,
    assertActivityAllowed: permit,
  };
}
async function directory() {
  const parent = join(
    process.cwd(),
    ".codex/artifacts/co-worker-resource-fairness-tests",
  );
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-"));
  roots.push(root);
  return root;
}

describe("Co-worker admission fairness", () => {
  test("a queued proactive review receives the next slot before a learning backlog", async () => {
    const admission = new CoWorkerResourceAdmission();
    const first = await admission.acquire(request("processing"));
    const order: string[] = [];
    const processing = admission
      .acquire(request("processing"))
      .then((release) => {
        order.push("processing");
        return release;
      });
    const proactive = admission
      .acquire(request("proactive"))
      .then((release) => {
        order.push("proactive");
        return release;
      });
    expect(admission.activeCalls).toBe(1);
    expect(order).toEqual([]);
    first();
    const finishProactive = await proactive;
    expect(order).toEqual(["proactive"]);
    finishProactive();
    const finishProcessing = await processing;
    expect(order).toEqual(["proactive", "processing"]);
    finishProcessing();
    expect(admission.activeCalls).toBe(0);
  });

  test("local exclusivity cannot be starved by new parallel cloud calls", async () => {
    const admission = new CoWorkerResourceAdmission();
    const maximum = () => 2;
    const first = await admission.acquire(request("processing", maximum));
    const second = await admission.acquire(request("processing", maximum));
    const order: string[] = [];
    const local = admission
      .acquire(request("proactive", maximum, false))
      .then((release) => {
        order.push("local");
        return release;
      });
    const cloud = admission
      .acquire(request("processing", maximum))
      .then((release) => {
        order.push("cloud");
        return release;
      });
    first();
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(admission.activeCalls).toBe(1);
    second();
    const releaseLocal = await local;
    expect(order).toEqual(["local"]);
    expect(admission.activeCalls).toBe(1);
    releaseLocal();
    (await cloud)();
    expect(order).toEqual(["local", "cloud"]);
  });

  test("checks lowered concurrency at release without interrupting admitted calls", async () => {
    const admission = new CoWorkerResourceAdmission();
    let maximum = 2;
    const one = await admission.acquire(request("processing", () => maximum));
    const two = await admission.acquire(request("processing", () => maximum));
    let granted = false;
    const pending = admission
      .acquire(request("proactive", () => maximum))
      .then((release) => {
        granted = true;
        return release;
      });
    maximum = 1;
    one();
    await Promise.resolve();
    expect(granted).toBe(false);
    two();
    (await pending)();
    expect(admission.activeCalls).toBe(0);
  });

  test("abort removes a waiting activity and the waiter bound prevents unbounded queues", async () => {
    const admission = new CoWorkerResourceAdmission();
    const active = await admission.acquire(request("processing"));
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const waiters = controllers.map((controller) =>
      admission
        .acquire({ ...request("proactive"), signal: controller.signal })
        .catch((error) => error),
    );
    expect(() => admission.acquire(request("processing"))).toThrow(
      "co_worker_resources_busy",
    );
    controllers.forEach((controller) =>
      controller.abort(new Error("explicitly_paused")),
    );
    expect(
      (await Promise.all(waiters)).every(
        (error) => error.message === "explicitly_paused",
      ),
    ).toBe(true);
    active();
    (await admission.acquire(request("processing")))();
    expect(admission.activeCalls).toBe(0);
  });

  test("a closed activity window rejects on release and does not block the next live waiter", async () => {
    const admission = new CoWorkerResourceAdmission();
    const active = await admission.acquire(request("processing"));
    let allowed = true;
    const expired = admission
      .acquire({
        ...request("proactive"),
        assertActivityAllowed: () => {
          if (!allowed) throw new Error("outside_window");
        },
      })
      .catch((error) => error);
    const live = admission.acquire(request("processing"));
    allowed = false;
    active();
    expect((await expired).message).toBe("outside_window");
    (await live)();
    expect(admission.activeCalls).toBe(0);
  });

  test("waiting and cancellation consume no quota and perform no background writes", async () => {
    const root = await directory();
    const budget = new CoWorkerResourceBudget({
      directory: root,
      limits: () => DEFAULT_CO_WORKER_RESOURCE_LIMITS,
    });
    const active = await budget.reserve({
      ...request("processing"),
      kind: "model",
    });
    const controller = new AbortController();
    const before = await stat(join(root, "resource-budget.json"));
    const pending = budget
      .reserve({
        ...request("proactive"),
        kind: "model",
        signal: controller.signal,
      })
      .catch((error) => error);
    expect(await budget.status()).toMatchObject({
      modelCalls: 1,
      activeCalls: 1,
    });
    controller.abort(new Error("explicitly_paused"));
    expect((await pending).message).toBe("explicitly_paused");
    expect((await stat(join(root, "resource-budget.json"))).mtimeMs).toBe(
      before.mtimeMs,
    );
    active();
    expect(await budget.status()).toMatchObject({
      modelCalls: 1,
      activeCalls: 0,
    });
  });

  test("the remaining daily slot goes to the waiting other activity before queued learning", async () => {
    const budget = new CoWorkerResourceBudget({
      directory: await directory(),
      limits: () => ({
        ...DEFAULT_CO_WORKER_RESOURCE_LIMITS,
        modelCallsPerDay: 2,
      }),
    });
    const first = await budget.reserve({
      ...request("processing"),
      kind: "model",
    });
    const processing = budget
      .reserve({ ...request("processing"), kind: "model" })
      .catch((error) => error);
    const proactive = budget.reserve({
      ...request("proactive"),
      kind: "model",
    });
    first();
    (await proactive)();
    expect((await processing).message).toBe(
      "co_worker_model_daily_budget_exhausted",
    );
    expect(await budget.status()).toMatchObject({
      modelCalls: 2,
      activeCalls: 0,
    });
  });
});
