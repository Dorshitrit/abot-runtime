import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { CoWorkerResourceBudget } from "../passive-learning/resources/budget.js";
import { DEFAULT_CO_WORKER_RESOURCE_LIMITS } from "../passive-learning/resources/contracts.js";
import { resolveCoWorkerBudgetDay } from "../passive-learning/resources/day-window.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function directory() {
  const parent = join(
    process.cwd(),
    ".codex/artifacts/co-worker-resource-window-tests",
  );
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-"));
  roots.push(root);
  return root;
}

describe("stable Co-worker daily delivery windows", () => {
  test("an unused window has a stable local-calendar start across read-only status calls", async () => {
    let now = Date.parse("2026-09-25T10:00:00Z");
    const root = await directory();
    const budget = new CoWorkerResourceBudget({
      directory: root,
      now: () => now,
      limits: () => ({
        ...DEFAULT_CO_WORKER_RESOURCE_LIMITS,
        timeZone: "Asia/Jerusalem",
      }),
    });
    const first = await budget.status();
    now += 3_600_000;
    expect(await budget.status()).toEqual(first);
    expect(first.startedAt).toBe(Date.parse("2026-09-24T21:00:00Z"));
    await expect(
      stat(join(root, "resource-budget.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("delivery initializes the current window once without consuming provider quota", async () => {
    let now = Date.parse("2026-09-25T10:00:00Z");
    const root = await directory();
    const budget = new CoWorkerResourceBudget({
      directory: root,
      now: () => now,
      limits: () => DEFAULT_CO_WORKER_RESOURCE_LIMITS,
    });
    const usage = await budget.ensureCurrentWindow();
    const initialStat = await stat(join(root, "resource-budget.json"));
    now += 1_000;
    expect(await budget.ensureCurrentWindow()).toEqual(usage);
    expect((await stat(join(root, "resource-budget.json"))).mtimeMs).toBe(
      initialStat.mtimeMs,
    );
    expect(usage).toMatchObject({
      modelCalls: 0,
      embeddingCalls: 0,
      activeCalls: 0,
    });
  });

  test("pending deliveries on a new day share one persisted window across later status and restart", async () => {
    let now = Date.parse("2026-09-25T10:00:00Z");
    const root = await directory();
    const create = () =>
      new CoWorkerResourceBudget({
        directory: root,
        now: () => now,
        limits: () => DEFAULT_CO_WORKER_RESOURCE_LIMITS,
      });
    await create().ensureCurrentWindow();
    now = Date.parse("2026-09-26T09:00:00Z");
    const delivered = await create().ensureCurrentWindow();
    const deliveredAt = now;
    now += 3_600_000;
    const later = await create().status();
    expect(later.startedAt).toBe(Date.parse("2026-09-26T00:00:00Z"));
    expect(later.startedAt).toBe(delivered.startedAt);
    expect(deliveredAt >= later.startedAt).toBe(true);
    expect(later.modelCalls).toBe(0);
  });

  test("a timezone edit persists the extended transition window instead of resetting it on reads", async () => {
    let now = Date.parse("2026-09-25T10:00:00Z");
    let timeZone = "UTC";
    const budget = new CoWorkerResourceBudget({
      directory: await directory(),
      now: () => now,
      limits: () => ({ ...DEFAULT_CO_WORKER_RESOURCE_LIMITS, timeZone }),
    });
    await budget.ensureCurrentWindow();
    timeZone = "Pacific/Kiritimati";
    now = Date.parse("2026-09-26T00:00:00Z");
    const transition = await budget.ensureCurrentWindow();
    now = Date.parse("2026-09-26T11:00:00Z");
    expect(await budget.status()).toEqual(transition);
    expect(transition.resetsAt).toBe(Date.parse("2026-09-27T10:00:00Z"));
  });

  test("calendar starts respect short DST days and skipped local midnight", () => {
    const spring = resolveCoWorkerBudgetDay(
      undefined,
      Date.parse("2026-03-08T15:00:00Z"),
      "America/New_York",
    );
    expect(spring.startedAt).toBe(Date.parse("2026-03-08T05:00:00Z"));
    expect(spring.resetsAt - spring.startedAt).toBe(23 * 3_600_000);
    const skipped = resolveCoWorkerBudgetDay(
      undefined,
      Date.parse("2026-03-08T15:00:00Z"),
      "America/Havana",
    );
    expect(skipped.startedAt).toBeLessThan(Date.parse("2026-03-08T05:00:00Z"));
    expect(skipped.resetsAt).toBeGreaterThan(skipped.startedAt);
  });
});
