import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const cases = [
  ["create", "createAutomation"], ["template", "createAutomation"], ["delete", "deleteAutomationDraft"],
  ["publish", "publishAutomation"], ["activate", "setAutomationActive"], ["archive", "archiveAutomation"],
  ["restore", "restoreAutomation"], ["permission", "setAutomationPermission"], ["update", "mutateAutomationDraft"],
] as const;
type Action = typeof cases[number][0];

function fixture(action: Action) {
  let environment = "dev";
  const draft = (automationId: string, env: string) => ({ automationId, revision: 1,
    definition: { title: `${env}/${automationId}`, body: { kind: "sequence", id: "root", children: [] } } });
  const response = () => ({ ok: true, draft: draft("created", "dev") });
  const command = () => vi.fn(async (..._args: unknown[]) => response());
  const client = {
    supportsAutomations: () => true,
    listAutomations: vi.fn(async (_env: string) => ({ automations: ["one", "two"].map((id) =>
      ({ id, publishedRevision: 2, status: action === "restore" ? "archived" : "paused" })) })),
    getAutomationCatalog: vi.fn(async () => ({ operations: [], models: [], savedAgents: [] })),
    getAutomationDraft: vi.fn(async (id: string, env: string) => ({ draft: draft(id, env) })),
    listAutomationRuns: vi.fn(async () => ({ runs: [] })),
    getAutomationRun: vi.fn(async (id: string, _env: string) => ({ run: { id, automationId: "one" } })),
    createAutomation: command(), deleteAutomationDraft: command(), publishAutomation: command(),
    setAutomationActive: command(), archiveAutomation: command(), restoreAutomation: command(),
    setAutomationPermission: command(), mutateAutomationDraft: command(),
  };
  const controller = createAutomationsController({ client, getEnvironmentId: () => environment,
    render: vi.fn(), isVisible: () => true });
  const invoke = () => {
    if (action === "template") return controller.createTemplate("starter");
    if (action === "delete") return controller.deleteDraft();
    if (action === "publish") return controller.publishDefinition();
    if (action === "activate") return controller.setActive(true);
    if (action === "permission") return controller.setPermission("full_access", []);
    if (action === "update") return controller.saveDefinition({ title: "Updated" });
    return controller[action]();
  };
  return { client, controller, draft, response, invoke, setEnvironment(value: string) { environment = value; } };
}

async function navigate(f: ReturnType<typeof fixture>, destination: string) {
  if (destination === "environment") {
    f.setEnvironment("prod");
    f.controller.environmentChanged();
    await f.controller.openRoute("one");
    return;
  }
  await f.controller.openRoute("two");
  if (destination === "away and back") await f.controller.openRoute("one");
}

describe("automation management write scopes", () => {
  test.each(cases.flatMap(([action, method]) => ["another automation", "environment", "away and back"]
    .flatMap((destination) => ["success", "failure"].map((outcome) => ({ action, method, destination, outcome })))))(
    "$action ignores late $outcome after $destination", async ({ action, method, destination, outcome }) => {
      const f = fixture(action);
      await f.controller.openRoute("one");
      const held = deferred<ReturnType<typeof f.response>>();
      f.client[method].mockImplementationOnce(() => held.promise);
      const pending = f.invoke();
      expect(f.client[method].mock.calls[0]?.at(-1)).toBe(action === "create" ? undefined
        : action === "template" ? "starter" : "dev");
      await navigate(f, destination);
      const before = f.controller.snapshot();
      const reads = f.client.listAutomations.mock.calls.length;
      if (outcome === "success") held.resolve(f.response());
      else held.reject(new Error("Obsolete command failure"));
      expect(await pending).toBe(false);
      expect(f.controller.snapshot()).toEqual({ ...before, mutation: "" });
      expect(f.client.listAutomations).toHaveBeenCalledTimes(reads);
    },
  );

  test.each(cases.flatMap(([action]) => ["environment", "away and back"]
    .flatMap((destination) => ["success", "failure"].map((outcome) => ({ action, destination, outcome })))))(
    "$action scopes pending refresh $outcome after $destination", async ({ action, destination, outcome }) => {
      const f = fixture(action);
      await f.controller.openRoute("one");
      const started = deferred<void>();
      const held = deferred<any>();
      if (action === "permission") f.client.getAutomationDraft.mockImplementationOnce(() => { started.resolve(); return held.promise; });
      else f.client.listAutomations.mockImplementationOnce(() => { started.resolve(); return held.promise; });
      const pending = f.invoke();
      await started.promise;
      await navigate(f, destination);
      const before = f.controller.snapshot();
      const reads = f.client.getAutomationDraft.mock.calls.length;
      if (outcome === "success") held.resolve(action === "permission"
        ? { draft: f.draft("obsolete", "dev") } : { automations: [{ id: "obsolete" }] });
      else held.reject(new Error("Obsolete refresh failure"));
      expect(await pending).toBe(false);
      expect(f.controller.snapshot()).toEqual(before);
      expect(f.client.getAutomationDraft).toHaveBeenCalledTimes(reads);
    },
  );

  test.each(cases)("%s respects a pending run click before its selected identity changes", async (action, method) => {
    const f = fixture(action);
    await f.controller.openRoute("one");
    const held = deferred<ReturnType<typeof f.response>>();
    const clicked = deferred<{ run: { id: string; automationId: string } }>();
    f.client[method].mockImplementationOnce(() => held.promise);
    f.client.getAutomationRun.mockImplementationOnce(() => clicked.promise);
    const pending = f.invoke();
    const navigation = f.controller.openRun("chosen");
    const before = f.controller.snapshot();
    held.resolve(f.response());
    expect(await pending).toBe(false);
    expect(f.controller.snapshot()).toEqual({ ...before, mutation: "" });
    clicked.resolve({ run: { id: "chosen", automationId: "one" } });
    expect(await navigation).toBe(true);
    expect(f.controller.snapshot().selectedRunId).toBe("chosen");
  });

  test.each(["create", "template"] as const)("%s opens the created draft only in its original current view", async (action) => {
    const f = fixture(action);
    await f.controller.openRoute("");
    expect(await f.invoke()).toBe(true);
    expect(f.client.createAutomation).toHaveBeenCalledExactlyOnceWith("dev", action === "template" ? "starter" : undefined);
    expect(f.controller.snapshot()).toMatchObject({ selectedAutomationId: "created", mutation: "", error: "" });
    expect(f.client.getAutomationDraft).toHaveBeenCalledWith("created", "dev");
  });

  test.each(["publish", "activate", "archive", "restore"] as const)(
    "%s keeps the second refresh read bound while a different run click is pending", async (action) => {
      const f = fixture(action);
      await f.controller.openRoute("one");
      const started = deferred<void>();
      const selected = deferred<{ draft: ReturnType<typeof f.draft> }>();
      const clicked = deferred<{ run: { id: string; automationId: string } }>();
      f.client.getAutomationDraft.mockImplementationOnce(() => { started.resolve(); return selected.promise; });
      const pending = f.invoke();
      await started.promise;
      f.client.getAutomationRun.mockImplementationOnce(() => clicked.promise);
      const navigation = f.controller.openRun("chosen");
      const before = f.controller.snapshot();
      selected.resolve({ draft: f.draft("obsolete", "dev") });
      expect(await pending).toBe(false);
      expect(f.controller.snapshot()).toEqual({ ...before, loading: false });
      clicked.resolve({ run: { id: "chosen", automationId: "one" } });
      expect(await navigation).toBe(true);
      expect(f.controller.snapshot().selectedRunId).toBe("chosen");
    },
  );

  test("the real environment reset keeps the old lock until settlement, then admits the new environment", async () => {
    const f = fixture("create");
    await f.controller.openRoute("");
    const old = deferred<ReturnType<typeof f.response>>();
    const current = deferred<ReturnType<typeof f.response>>();
    f.client.createAutomation.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    const first = f.invoke();
    f.setEnvironment("prod");
    f.controller.environmentChanged();
    expect(f.controller.snapshot().mutation).toBe("Draft");
    expect(await f.invoke()).toBe(false);
    expect(f.client.createAutomation).toHaveBeenCalledOnce();
    old.resolve(f.response());
    expect(await first).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ mutation: "", feedback: "", error: "" });
    const second = f.invoke();
    expect(f.client.createAutomation).toHaveBeenLastCalledWith("prod", undefined);
    expect(f.controller.snapshot().mutation).toBe("Draft");
    current.resolve({ ok: true, draft: f.draft("created", "prod") });
    expect(await second).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ selectedAutomationId: "created", mutation: "", error: "" });
  });

  test.each(["route list", "route selection", "refresh list", "refresh selection"].flatMap((read) =>
    ["success", "failure"].map((outcome) => ({ read, outcome }))))(
    "$read cannot replace a newer selected run after late $outcome", async ({ read, outcome }) => {
      const f = fixture("publish");
      await f.controller.openRoute("one", "old");
      const held = deferred<any>();
      const started = deferred<void>();
      if (read.endsWith("list")) f.client.listAutomations.mockImplementationOnce(() => { started.resolve(); return held.promise; });
      else f.client.getAutomationDraft.mockImplementationOnce(() => { started.resolve(); return held.promise; });
      const pending = read.startsWith("refresh") ? f.controller.refresh()
        : read.endsWith("list") ? f.controller.openRoute("") : f.controller.openRoute("one", "old");
      await started.promise;
      expect(await f.controller.openRun("new")).toBe(true);
      const before = f.controller.snapshot();
      expect(before).toMatchObject({ selectedRunId: "new", run: { id: "new" } });
      if (outcome === "failure") held.reject(new Error("Old view failed"));
      else held.resolve(read.endsWith("list") ? { automations: [{ id: "obsolete" }] }
        : { draft: f.draft("obsolete", "dev") });
      expect(await pending).toBe(false);
      expect(f.controller.snapshot()).toEqual({ ...before, loading: false });
    },
  );
});
