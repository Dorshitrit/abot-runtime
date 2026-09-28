import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CoWorkerResourceBudget } from "../passive-learning/resources/budget.js";
import { DEFAULT_CO_WORKER_RESOURCE_LIMITS } from "../passive-learning/resources/contracts.js";
import { createCoWorkerResourceGateway } from "../passive-learning/resources/gateway.js";
import type { ModelGatewayClient } from "../ports.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const parent = join(process.cwd(), ".codex/artifacts/co-worker-resource-budget-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-"));
  roots.push(root);
  return root;
}
const signal = () => new AbortController().signal;
const permit = () => {};
const modelReservation = () => ({ kind: "model" as const, supportsParallel: true,
  signal: signal(), assertActivityAllowed: permit });
function gatewayMock(): ModelGatewayClient {
  return {
    invoke: vi.fn(async () => ({ text: "ok", meta: {} })),
    invokeRaw: vi.fn(async () => ({ text: "ok", meta: { status: 200, outputLength: 2, thinkingLength: 0 } })),
    countInputTokens: vi.fn(async () => undefined),
    embed: vi.fn(async () => ({ profileId: "embedding", provider: "ollama" as const, model: "embedding",
      modelFingerprint: "fingerprint", dimensions: 1, vectors: [[1]] })),
  };
}

describe("Co-worker durable resource admission", () => {
  test("persists failed attempts across reconstruction and caps concurrent reservations atomically", async () => {
    const root = await directory();
    const limits = { ...DEFAULT_CO_WORKER_RESOURCE_LIMITS, modelCallsPerDay: 2 };
    const create = () => new CoWorkerResourceBudget({ directory: root, limits: () => limits });
    const one = create();
    const two = create();
    const three = create();
    const attempts = await Promise.allSettled([one.reserve(modelReservation()),
      two.reserve(modelReservation()), three.reserve(modelReservation())]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(2);
    for (const attempt of attempts) if (attempt.status === "fulfilled") attempt.value();
    expect(await create().status()).toMatchObject({ modelCalls: 2, activeCalls: 0 });
    await expect(create().reserve(modelReservation())).rejects.toThrow("co_worker_model_daily_budget_exhausted");
    expect((await readFile(join(root, "resource-budget.json"), "utf8")).length).toBeLessThan(2_048);
  });

  test("uses one shared slot pool and makes any local operation exclusive", async () => {
    const budget = new CoWorkerResourceBudget({ directory: await directory(),
      limits: () => ({ ...DEFAULT_CO_WORKER_RESOURCE_LIMITS, maxConcurrentCalls: 2 }) });
    const cloud = await budget.reserve(modelReservation());
    await expect(budget.reserve({ ...modelReservation(), supportsParallel: false }))
      .rejects.toThrow("co_worker_resources_busy");
    const second = await budget.reserve(modelReservation());
    await expect(budget.reserve(modelReservation())).rejects.toThrow("co_worker_resources_busy");
    cloud(); cloud(); second();
    const local = await budget.reserve({ ...modelReservation(), kind: "embedding", supportsParallel: false });
    await expect(budget.reserve(modelReservation())).rejects.toThrow("co_worker_resources_busy");
    local();
    expect(await budget.status()).toMatchObject({ modelCalls: 2, embeddingCalls: 1, activeCalls: 0 });
  });

  test("zone edits cannot reset the current day or shorten a transition day", async () => {
    let now = Date.parse("2026-09-25T10:00:00Z");
    let timeZone = "UTC";
    const budget = new CoWorkerResourceBudget({ directory: await directory(),
      limits: () => ({ ...DEFAULT_CO_WORKER_RESOURCE_LIMITS, timeZone }), now: () => now });
    (await budget.reserve(modelReservation()))();
    timeZone = "Pacific/Kiritimati";
    expect(await budget.status()).toMatchObject({ modelCalls: 1, resetsAt: Date.parse("2026-09-26T00:00:00Z") });
    now = Date.parse("2026-09-26T00:00:00Z");
    (await budget.reserve(modelReservation()))();
    expect(await budget.status()).toMatchObject({ modelCalls: 1, timeZone,
      resetsAt: Date.parse("2026-09-27T10:00:00Z") });
    timeZone = "America/Los_Angeles";
    expect((await budget.status()).resetsAt).toBe(Date.parse("2026-09-27T10:00:00Z"));
  });

  test("keeps calendar rollover through daylight saving changes", async () => {
    let now = Date.parse("2026-03-08T05:01:00Z");
    const budget = new CoWorkerResourceBudget({ directory: await directory(),
      limits: () => ({ ...DEFAULT_CO_WORKER_RESOURCE_LIMITS, timeZone: "America/New_York" }), now: () => now });
    (await budget.reserve(modelReservation()))();
    expect((await budget.status()).resetsAt).toBe(Date.parse("2026-03-09T04:00:00Z"));
    now = Date.parse("2026-03-09T04:00:00Z");
    expect((await budget.status()).modelCalls).toBe(0);
  });

  test("status is read only, corrupt state fails closed, and there are no periodic writes", async () => {
    const root = await directory();
    const budget = new CoWorkerResourceBudget({ directory: root, limits: () => DEFAULT_CO_WORKER_RESOURCE_LIMITS });
    await budget.status();
    await expect(stat(join(root, "resource-budget.json"))).rejects.toMatchObject({ code: "ENOENT" });
    (await budget.reserve(modelReservation()))();
    const before = await stat(join(root, "resource-budget.json"));
    await budget.status(); await budget.status();
    expect((await stat(join(root, "resource-budget.json"))).mtimeMs).toBe(before.mtimeMs);
    await writeFile(join(root, "resource-budget.json"), "x".repeat(2_049));
    await expect(budget.reserve(modelReservation())).rejects.toThrow("co_worker_budget_state_too_large");
  });
});

describe("Co-worker gateway boundary", () => {
  test("charges each provider attempt including failures and preserves token counting", async () => {
    const base = gatewayMock();
    vi.mocked(base.invoke).mockRejectedValueOnce(new Error("provider_failed"));
    const budget = new CoWorkerResourceBudget({ directory: await directory(), limits: () => DEFAULT_CO_WORKER_RESOURCE_LIMITS });
    const client = createCoWorkerResourceGateway({ gateway: base, budget,
      assertActivityAllowed: permit, supportsParallel: () => true });
    const chat = { agentMode: "reasoning" as const, abortSignal: signal() };
    await expect(client.invoke(chat)).rejects.toThrow("provider_failed");
    await client.invoke(chat);
    await client.invokeRaw({ ...chat, prompt: "bounded" });
    expect(await budget.status()).toMatchObject({ modelCalls: 3, activeCalls: 0 });
    const counter = { ...chat, provider: "ollama" as const, messages: [] };
    await client.countInputTokens!(counter);
    expect(base.countInputTokens).toHaveBeenCalledWith(counter);
    expect((await budget.status()).modelCalls).toBe(3);
  });

  test("checks each split call and does not start transport when paused", async () => {
    let allowed = true;
    const base = gatewayMock();
    const budget = new CoWorkerResourceBudget({ directory: await directory(), limits: () => DEFAULT_CO_WORKER_RESOURCE_LIMITS });
    const client = createCoWorkerResourceGateway({ gateway: base, budget,
      supportsParallel: () => true, assertActivityAllowed: () => {
        if (!allowed) throw new Error("activity_paused");
      } });
    const chat = { agentMode: "reasoning" as const, abortSignal: signal() };
    await client.invoke(chat);
    allowed = false;
    await expect(client.invoke(chat)).rejects.toThrow("activity_paused");
    expect(base.invoke).toHaveBeenCalledTimes(1);
    expect((await budget.status()).modelCalls).toBe(1);
  });

  test("bounds embeddings independently by both calls and input characters", async () => {
    const base = gatewayMock();
    const budget = new CoWorkerResourceBudget({ directory: await directory(), limits: () => ({
      ...DEFAULT_CO_WORKER_RESOURCE_LIMITS, embeddingCallsPerDay: 2, embeddingCharactersPerDay: 6 }) });
    const client = createCoWorkerResourceGateway({ gateway: base, budget,
      assertActivityAllowed: permit, supportsParallel: () => true });
    const params = { profileId: "embedding", texts: ["abc"], abortSignal: signal() };
    await client.embed!(params);
    await expect(client.embed!({ ...params, texts: ["abcd"] }))
      .rejects.toThrow("co_worker_embedding_character_budget_exhausted");
    await client.embed!(params);
    await expect(client.embed!(params)).rejects.toThrow("co_worker_embedding_daily_budget_exhausted");
    expect(await budget.status()).toMatchObject({ modelCalls: 0, embeddingCalls: 2, embeddingCharacters: 6 });
  });

  test("blocks dispatch after controls change during reservation without refunding the admitted slot", async () => {
    const base = gatewayMock();
    let checks = 0;
    const budget = new CoWorkerResourceBudget({ directory: await directory(), limits: () => DEFAULT_CO_WORKER_RESOURCE_LIMITS });
    const client = createCoWorkerResourceGateway({ gateway: base, budget, supportsParallel: () => true,
      assertActivityAllowed: () => {
        checks += 1;
        if (checks === 3) throw new Error("activity_paused");
      } });
    await expect(client.invoke({ agentMode: "reasoning", abortSignal: signal() })).rejects.toThrow("activity_paused");
    expect(base.invoke).not.toHaveBeenCalled();
    expect(await budget.status()).toMatchObject({ modelCalls: 1, activeCalls: 0 });
  });

  test("releases concurrency on cancellation and preserves unsupported optional methods", async () => {
    const controller = new AbortController();
    const base = gatewayMock();
    delete base.embed; delete base.countInputTokens;
    vi.mocked(base.invoke).mockImplementationOnce(async () => {
      controller.abort(); controller.signal.throwIfAborted();
      return { text: "unreachable", meta: {} };
    });
    const budget = new CoWorkerResourceBudget({ directory: await directory(), limits: () => DEFAULT_CO_WORKER_RESOURCE_LIMITS });
    const client = createCoWorkerResourceGateway({ gateway: base, budget,
      assertActivityAllowed: permit, supportsParallel: () => false });
    expect(client.embed).toBeUndefined(); expect(client.countInputTokens).toBeUndefined();
    await expect(client.invoke({ agentMode: "reasoning", abortSignal: controller.signal })).rejects.toBeDefined();
    await client.invoke({ agentMode: "reasoning", abortSignal: signal() });
    expect(await budget.status()).toMatchObject({ modelCalls: 2, activeCalls: 0 });
  });
});
