import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createAgentDrafts } from "../../web-ui/app/components/agents/drafts.js";
// @ts-expect-error Browser-only module.
import { createAgentSchedules } from "../../web-ui/app/components/agents/schedule-controller.js";
// @ts-expect-error Browser-only module.
import { createAgentDraftMigration } from "../../web-ui/app/components/agents/draft-migration-dialog.js";
const key = "abot-web.agentDrafts";
const scope = (environment: string, id: string) => JSON.stringify([environment, id]);
const pending = { text: "  A task with exact whitespace\n", intent: "task", pendingId: "receipt-before-rename", onboarding: "" };
function saved(values: Record<string, unknown>) {
  let raw = JSON.stringify(values);
  const storage = { getItem: (id: string) => id === key ? raw : null, setItem: vi.fn(async (_id: string, next: string) => { raw = next; }) };
  return { storage, read: () => JSON.parse(raw), drafts: createAgentDrafts(storage) };
}

describe("legacy coordinator draft migration", () => {
  test("reads the legacy receipt and moves it unchanged on the first ABot write", async () => {
    const h = saved({ [scope("dev", "spark")]: pending, [scope("prod", "spark")]: { ...pending, text: "Other environment" } });
    expect(h.drafts.read("dev", "abot")).toEqual(pending);
    expect(h.storage.setItem).not.toHaveBeenCalled();
    await h.drafts.write("dev", "abot", h.drafts.read("dev", "abot"));
    expect(h.read()[scope("dev", "abot")]).toEqual(pending);
    expect(h.read()[scope("dev", "spark")]).toBeUndefined();
    expect(h.read()[scope("prod", "spark")].text).toBe("Other environment");
    expect(createAgentDrafts(h.storage).read("dev", "abot")).toEqual(pending);
  });
  test.each([":onboarding", ":schedule", ":resume", ":steer"])("preserves the complete %s payload", async (suffix) => {
    const value = { ...pending, onboarding: '{"name":"ABot","id":"existing-schedule","budget":"custom"}' };
    const h = saved({ [scope("dev", `spark${suffix}`)]: value });
    await h.drafts.write("dev", `abot${suffix}`, h.drafts.read("dev", `abot${suffix}`));
    expect(h.read()).toEqual({ [scope("dev", `abot${suffix}`)]: value });
  });
  test("a collision preserves both different pending receipts and never writes", async () => {
    const before = { [scope("dev", "spark")]: pending, [scope("dev", "abot")]: { ...pending, text: "New draft", pendingId: "new-receipt" } }, h = saved(before);
    expect(() => h.drafts.read("dev", "abot")).toThrow(/Both are preserved/);
    await expect(h.drafts.write("dev", "abot", {})).rejects.toMatchObject({ code: "agents_legacy_draft_conflict" });
    expect(h.storage.setItem).not.toHaveBeenCalled(); expect(h.read()).toEqual(before);
  });
  test("identical aliases can consolidate without changing their receipt", async () => {
    const h = saved({ [scope("dev", "spark")]: pending, [scope("dev", "abot")]: { ...pending } });
    await h.drafts.write("dev", "abot", pending);
    expect(h.read()).toEqual({ [scope("dev", "abot")]: pending });
  });
  test("an explicit choice keeps the other pending receipt recoverable and can swap it back", async () => {
    const current = { ...pending, text: "New draft", pendingId: "new-receipt" };
    const h = saved({ [scope("dev", "spark")]: pending, [scope("dev", "abot")]: current });
    let collision: any;
    try { h.drafts.read("dev", "abot"); } catch (error) { collision = (error as any).collision; }
    await h.drafts.resolveConflict(collision, "legacy");
    expect(h.drafts.read("dev", "abot")).toEqual(pending);
    const backups = h.drafts.recovered("dev", "abot");
    expect(backups).toHaveLength(1); expect(backups[0].value).toEqual(current);
    await h.drafts.restoreRecovered("dev", backups[0]);
    expect(createAgentDrafts(h.storage).read("dev", "abot")).toEqual(current);
    expect(h.drafts.recovered("dev", "abot")[0].value).toEqual(pending);
  });
  test("the conflict dialog previews both choices, retains the unchosen draft, and never sends", async () => {
    const current = { ...pending, text: "<img onerror=run()>", pendingId: "new-receipt" };
    const h = saved({ [scope("dev", "spark")]: pending, [scope("dev", "abot")]: current });
    let failure: any;
    try { h.drafts.read("dev", "abot"); } catch (error) { failure = error; }
    const view = { migration: vi.fn() }, onResolved = vi.fn();
    const dialog = createAgentDraftMigration({ drafts: h.drafts, view, getScope: () => ({ environment: "dev", selected: "abot" }), onResolved });
    dialog.conflict(failure);
    expect(view.migration.mock.calls.at(-1)?.[0]).toContain("Saved after the rename");
    expect(view.migration.mock.calls.at(-1)?.[0]).not.toContain("<img");
    await dialog.click({ dataset: { migrationChoice: "current" } });
    expect(h.drafts.read("dev", "abot")).toEqual(current);
    expect(h.drafts.recovered("dev", "abot")[0].value).toEqual(pending);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
  test("schedule onboarding exposes a conflict instead of silently replacing a legacy draft", async () => {
    const h = saved({ [scope("dev", "spark:schedule")]: { ...pending, onboarding: '{"id":"old-schedule"}' }, [scope("dev", "abot:schedule")]: { ...pending, onboarding: '{"id":"new-schedule"}' } });
    const controller = createAgentSchedules({ client: { listAgentSchedules: async () => ({ schedules: [] }) }, drafts: h.drafts, view: { schedules: vi.fn() }, getScope: () => ({ environment: "dev", selected: "abot" }), viewport: { crypto: { randomUUID: () => "unused" } } });
    await controller.open({ agent: { definition: { name: "ABot" } } });
    await expect(controller.click({ dataset: { scheduleAction: "new" } })).rejects.toMatchObject({ code: "agents_legacy_draft_conflict" });
    expect(h.storage.setItem).not.toHaveBeenCalled();
  });
});
