import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const draft = (id: string) => ({ automationId: id, revision: 1,
    definition: { title: id, body: { kind: "sequence", id: "root", children: [] } } });
  const client = {
    supportsAutomations: () => true,
    listAutomations: vi.fn(async () => ({ automations: [{ id: "one", publishedRevision: 1, status: "paused" }] })),
    getAutomationCatalog: vi.fn(async () => ({ operations: [], models: [], savedAgents: [] })),
    getAutomationDraft: vi.fn(async (id: string) => ({ draft: draft(id) })),
    listAutomationRuns: vi.fn(async () => ({ runs: [] })),
    getAutomationRun: vi.fn(async (id: string) => ({ run: { id, automationId: "one" } })),
    createAutomation: vi.fn(async () => ({ draft: draft("first") })),
    publishAutomation: vi.fn(async () => ({ ok: true })),
    setAutomationPermission: vi.fn(async () => ({ ok: true })),
    mutateAutomationDraft: vi.fn(async () => ({ draft: { ...draft("one"), revision: 2 } })),
    startAutomationRun: vi.fn(async () => ({ run: { id: "created-run" } })),
    rerunAutomationRun: vi.fn(async () => ({ run: { id: "created-run" } })),
    stopAutomationRun: vi.fn(async () => ({ ok: true })),
  };
  const controller = createAutomationsController({ client, getEnvironmentId: () => "dev", render: vi.fn() });
  return { client, controller, draft };
}

const cases = [
  { action: "refresh", read: "list" }, { action: "refresh", read: "selection" },
  { action: "create", read: "list" }, { action: "publishDefinition", read: "list" },
  { action: "permission", read: "selection" }, { action: "update", read: "list" },
  { action: "startRun", read: "selection" }, { action: "rerun", read: "selection" },
  { action: "stopRun", read: "run" },
] as const;

test.each(cases.flatMap((item) => ["success", "failure"].map((outcome) => ({ ...item, outcome })) ))(
  "new creation supersedes $action pending $read $outcome without clearing its lock", async ({ action, read, outcome }) => {
    const f = fixture();
    await f.controller.openRoute("one", "old");
    const started = deferred<void>(), firstRead = deferred<any>();
    if (read === "list") f.client.listAutomations.mockImplementationOnce(() => { started.resolve(); return firstRead.promise; });
    if (read === "selection") f.client.getAutomationDraft.mockImplementationOnce(() => { started.resolve(); return firstRead.promise; });
    if (read === "run") f.client.getAutomationRun.mockImplementationOnce(() => { started.resolve(); return firstRead.promise; });
    const first = action === "permission" ? f.controller.setPermission("full_access", [])
      : action === "update" ? f.controller.saveDefinition({ title: "Updated" }) : f.controller[action]();
    await started.promise;
    expect(f.controller.snapshot().mutation).toBe("");
    const newerWrite = deferred<{ draft: ReturnType<typeof f.draft> }>();
    f.client.createAutomation.mockImplementationOnce(() => newerWrite.promise);
    const second = f.controller.create();
    const before = f.controller.snapshot();
    expect(before.mutation).toBe("Draft");
    if (outcome === "failure") firstRead.reject(new Error("Obsolete read failed"));
    else firstRead.resolve(read === "list" ? { automations: [{ id: "obsolete" }] }
      : read === "selection" ? { draft: f.draft("obsolete") } : { run: { id: "old", automationId: "one" } });
    expect(await first).toBe(false);
    expect(f.controller.snapshot()).toEqual({ ...before, loading: false, runStartPending: false });
    newerWrite.resolve({ draft: f.draft("second") });
    expect(await second).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ selectedAutomationId: "second", mutation: "", error: "" });
    expect(f.client.getAutomationDraft).toHaveBeenLastCalledWith("second", "dev");
  },
);

test("a newer mutation also supersedes the old creation's opened-route selection read", async () => {
  const f = fixture();
  await f.controller.openRoute("one");
  const started = deferred<void>(), oldSelection = deferred<{ draft: ReturnType<typeof f.draft> }>();
  f.client.getAutomationDraft.mockImplementationOnce(() => { started.resolve(); return oldSelection.promise; });
  const first = f.controller.create();
  await started.promise;
  const newerWrite = deferred<{ draft: ReturnType<typeof f.draft> }>();
  f.client.createAutomation.mockImplementationOnce(() => newerWrite.promise);
  const second = f.controller.create();
  const before = f.controller.snapshot();
  oldSelection.resolve({ draft: f.draft("first") });
  expect(await first).toBe(false);
  expect(f.controller.snapshot()).toEqual({ ...before, loading: false });
  newerWrite.resolve({ draft: f.draft("second") });
  expect(await second).toBe(true);
  expect(f.controller.snapshot().selectedAutomationId).toBe("second");
});
