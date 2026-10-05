import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

type Action = "startRun" | "stopRun" | "rerun";
type Destination = "automation" | "environment" | "away and back" | "run" | "environment before reset";
const actions: readonly Action[] = ["startRun", "stopRun", "rerun"];
const destinations: readonly Destination[] = ["automation", "environment", "away and back", "run", "environment before reset"];

function fixture() {
  let environment = "dev";
  const draft = (id: string) => ({ draft: { automationId: id, revision: 1,
    definition: { title: id, body: { kind: "sequence", id: "root", children: [] } } } });
  const client = {
    supportsAutomations: () => true,
    listAutomations: vi.fn(async () => ({ automations: [{ id: "one" }, { id: "two" }] })),
    getAutomationCatalog: vi.fn(async () => ({ operations: [], models: [], savedAgents: [] })),
    getAutomationDraft: vi.fn(async (id: string) => draft(id)),
    listAutomationRuns: vi.fn(async () => ({ runs: [] })),
    getAutomationRun: vi.fn(async (id: string, _environment: string) => ({ run: { id, automationId: "one" } })),
    startAutomationRun: vi.fn(async (_id: string, _request: string, _environment: string) => ({ run: { id: "created" } })),
    stopAutomationRun: vi.fn(async (_id: string, _environment: string) => ({ run: { id: "old" } })),
    rerunAutomationRun: vi.fn(async (_id: string, _request: string, _environment: string) => ({ run: { id: "created" } })),
  };
  const controller = createAutomationsController({ client, getEnvironmentId: () => environment,
    render: vi.fn(), isVisible: () => true });
  const command = (action: Action) => action === "startRun" ? client.startAutomationRun
    : action === "stopRun" ? client.stopAutomationRun : client.rerunAutomationRun;
  return { client, controller, draft, command, setEnvironment(value: string) { environment = value; } };
}

async function changeView(f: ReturnType<typeof fixture>, destination: Destination) {
  if (destination.startsWith("environment")) {
    f.setEnvironment("prod");
    if (destination === "environment before reset") return;
    f.controller.environmentChanged();
    await f.controller.openRoute("one", "old");
    return;
  }
  if (destination === "run") { await f.controller.openRun("another"); return; }
  await f.controller.openRoute("two");
  if (destination === "away and back") await f.controller.openRoute("one", "old");
}

describe("automation run command view ownership", () => {
  test.each(actions.flatMap((action) => destinations.flatMap((destination) =>
    ["success", "failure"].map((outcome) => ({ action, destination, outcome })))))(
    "$action ignores pending $outcome after $destination changes", async ({ action, destination, outcome }) => {
      const f = fixture();
      await f.controller.openRoute("one", "old");
      const held = deferred<{ run: { id: string } }>();
      f.command(action).mockImplementationOnce(() => held.promise);
      const pending = f.controller[action]();
      if (action === "stopRun") expect(f.command(action)).toHaveBeenCalledExactlyOnceWith("old", "dev");
      else expect(f.command(action)).toHaveBeenCalledExactlyOnceWith(
        action === "startRun" ? "one" : "old", expect.any(String), "dev");
      await changeView(f, destination);
      const before = f.controller.snapshot();
      const reads = [f.client.getAutomationDraft.mock.calls.length, f.client.getAutomationRun.mock.calls.length];
      if (outcome === "success") held.resolve({ run: { id: "created" } });
      else held.reject(new Error("Stale run action failed"));
      expect(await pending).toBe(false);
      expect(f.controller.snapshot()).toEqual({ ...before, mutation: "", runStartPending: false });
      expect([f.client.getAutomationDraft.mock.calls.length, f.client.getAutomationRun.mock.calls.length]).toEqual(reads);
    },
  );

  test.each((["startRun", "rerun"] as const).flatMap((action) =>
    destinations.flatMap((destination) => ["success", "failure"].map((outcome) => ({ action, destination, outcome })))))(
    "$action ignores refresh $outcome after $destination changes", async ({ action, destination, outcome }) => {
      const f = fixture();
      await f.controller.openRoute("one", "old");
      const started = deferred<void>();
      const held = deferred<ReturnType<typeof f.draft>>();
      f.client.getAutomationDraft.mockImplementationOnce(() => { started.resolve(); return held.promise; });
      const pending = f.controller[action]();
      await started.promise;
      await changeView(f, destination);
      const before = f.controller.snapshot();
      const reads = f.client.getAutomationRun.mock.calls.length;
      if (outcome === "success") held.resolve({ draft: { ...f.draft("one").draft, revision: 999 } });
      else held.reject(new Error("Stale refresh failed"));
      expect(await pending).toBe(false);
      expect(f.controller.snapshot()).toEqual({ ...before, loading: false, runStartPending: false });
      expect(f.client.getAutomationRun).toHaveBeenCalledTimes(reads);
    },
  );

  test.each(actions)("%s opens only the current action's run and suppresses a double click", async (action) => {
    const f = fixture();
    await f.controller.openRoute("one", "old");
    const held = deferred<{ run: { id: string } }>();
    f.command(action).mockImplementationOnce(() => held.promise);
    const pending = f.controller[action]();
    expect(await f.controller[action]()).toBe(false);
    expect(f.command(action)).toHaveBeenCalledOnce();
    held.resolve({ run: { id: action === "stopRun" ? "old" : "created" } });
    expect(await pending).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ selectedAutomationId: "one",
      selectedRunId: action === "stopRun" ? "old" : "created", mutation: "", error: "" });
  });

  test.each(actions)("%s exposes a current failure and requires a selected target", async (action) => {
    const f = fixture();
    expect(await f.controller[action]()).toBe(false);
    expect(f.command(action)).not.toHaveBeenCalled();
    await f.controller.openRoute("one", "old");
    f.command(action).mockRejectedValueOnce(new Error("Current command failed"));
    expect(await f.controller[action]()).toBe(false);
    expect(f.controller.snapshot().error).toBe("Current command failed");
  });

  test.each((["startRun", "rerun"] as const).flatMap((action) =>
    ["command", "selection", "run"].map((phase) => ({ action, phase }))))(
    "$action stays pending and rejects another start throughout its $phase", async ({ action, phase }) => {
      const f = fixture();
      await f.controller.openRoute("one", "old");
      const entered = deferred<void>(), held = deferred<any>();
      const read = phase === "command" ? f.command(action)
        : phase === "selection" ? f.client.getAutomationDraft : f.client.getAutomationRun;
      read.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
      const pending = f.controller[action]();
      await entered.promise;
      expect(f.controller.snapshot().runStartPending).toBe(true);
      expect(await f.controller.startRun()).toBe(false);
      expect(await f.controller.rerun()).toBe(false);
      expect(f.client.startAutomationRun.mock.calls.length + f.client.rerunAutomationRun.mock.calls.length).toBe(1);
      held.resolve(phase === "selection" ? f.draft("one") : { run: { id: "created", automationId: "one" } });
      expect(await pending).toBe(true);
      expect(f.controller.snapshot()).toMatchObject({ selectedRunId: "created", runStartPending: false });
      expect(await f.controller[action]()).toBe(true);
      expect(f.command(action)).toHaveBeenCalledTimes(2);
    },
  );

  test.each((["startRun", "rerun"] as const).flatMap((action) =>
    ["command", "selection", "run"].map((phase) => ({ action, phase }))))(
    "$action releases its pending control after a $phase failure", async ({ action, phase }) => {
      const f = fixture();
      await f.controller.openRoute("one", "old");
      const failed = phase === "command" ? f.command(action)
        : phase === "selection" ? f.client.getAutomationDraft : f.client.getAutomationRun;
      failed.mockRejectedValueOnce(new Error("Run could not open"));
      expect(await f.controller[action]()).toBe(false);
      expect(f.controller.snapshot()).toMatchObject({ runStartPending: false, error: "Run could not open" });
      expect(await f.controller[action]()).toBe(true);
    },
  );

  test("pending starts follow their environment and automation while unrelated starts stay independent", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    const entered = deferred<void>(), held = deferred<any>();
    f.client.getAutomationDraft.mockImplementationOnce(() => { entered.resolve(); return held.promise; });
    const pending = f.controller.startRun();
    await entered.promise;
    await f.controller.openRoute("two");
    expect(f.controller.snapshot().runStartPending).toBe(false);
    f.client.getAutomationRun.mockResolvedValueOnce({ run: { id: "other", automationId: "two" } });
    expect(await f.controller.startRun()).toBe(true);
    await f.controller.openRoute("one");
    expect(f.controller.snapshot().runStartPending).toBe(true);
    expect(await f.controller.startRun()).toBe(false);
    f.setEnvironment("prod");
    f.controller.environmentChanged();
    await f.controller.openRoute("one");
    expect(f.controller.snapshot().runStartPending).toBe(false);
    expect(await f.controller.startRun()).toBe(true);
    held.resolve(f.draft("one"));
    expect(await pending).toBe(false);
    expect(f.controller.snapshot().runStartPending).toBe(false);
    expect(f.client.startAutomationRun).toHaveBeenCalledTimes(3);
  });

  test.each(actions)("%s respects a later run click whose GET is still pending", async (action) => {
    const f = fixture();
    await f.controller.openRoute("one", "old");
    const command = deferred<{ run: { id: string } }>();
    const clicked = deferred<{ run: { id: string; automationId: string } }>();
    f.command(action).mockImplementationOnce(() => command.promise);
    f.client.getAutomationRun.mockImplementationOnce(() => clicked.promise);
    const pending = f.controller[action]();
    const navigation = f.controller.openRun("chosen");
    command.resolve({ run: { id: "created" } });
    expect(await pending).toBe(false);
    expect(f.client.getAutomationRun).toHaveBeenCalledTimes(2);
    clicked.resolve({ run: { id: "chosen", automationId: "one" } });
    expect(await navigation).toBe(true);
    expect(f.controller.snapshot().selectedRunId).toBe("chosen");
  });

  test.each(["startRun", "rerun"] as const)("%s respects a pending run click during its refresh", async (action) => {
    const f = fixture();
    await f.controller.openRoute("one", "old");
    const started = deferred<void>();
    const refresh = deferred<ReturnType<typeof f.draft>>();
    const clicked = deferred<{ run: { id: string; automationId: string } }>();
    f.client.getAutomationDraft.mockImplementationOnce(() => { started.resolve(); return refresh.promise; });
    const pending = f.controller[action]();
    await started.promise;
    f.client.getAutomationRun.mockImplementationOnce(() => clicked.promise);
    const navigation = f.controller.openRun("chosen");
    refresh.resolve({ draft: { ...f.draft("one").draft, revision: 999 } });
    expect(await pending).toBe(false);
    expect(f.controller.snapshot().draft.revision).toBe(1);
    expect(f.client.getAutomationRun).toHaveBeenCalledTimes(2);
    clicked.resolve({ run: { id: "chosen", automationId: "one" } });
    expect(await navigation).toBe(true);
    expect(f.controller.snapshot().selectedRunId).toBe("chosen");
  });

  test.each(actions)("%s respects navigation to the list before the list GET completes", async (action) => {
    const f = fixture();
    await f.controller.openRoute("one", "old");
    const command = deferred<{ run: { id: string } }>();
    const listed = deferred<{ automations: { id: string }[] }>();
    f.command(action).mockImplementationOnce(() => command.promise);
    f.client.listAutomations.mockImplementationOnce(() => listed.promise);
    const pending = f.controller[action]();
    const navigation = f.controller.openRoute("");
    command.resolve({ run: { id: "created" } });
    expect(await pending).toBe(false);
    expect(f.client.getAutomationRun).toHaveBeenCalledOnce();
    listed.resolve({ automations: [{ id: "one" }] });
    expect(await navigation).toBe(true);
    expect(f.controller.snapshot().selectedAutomationId).toBe("");
  });

  test.each(["newer route", "environment"])("a pending route cannot override a %s", async (change) => {
    const f = fixture();
    const listed = deferred<{ automations: { id: string }[] }>();
    f.client.listAutomations.mockImplementationOnce(() => listed.promise);
    const pending = f.controller.openRoute("one");
    if (change === "environment") {
      f.setEnvironment("prod");
      f.controller.environmentChanged();
    }
    await f.controller.openRoute("two");
    const before = f.controller.snapshot();
    listed.resolve({ automations: [{ id: "one" }] });
    expect(await pending).toBe(false);
    expect(f.controller.snapshot()).toEqual(before);
    expect(f.client.getAutomationDraft).toHaveBeenCalledTimes(1);
    expect(f.client.getAutomationDraft).toHaveBeenCalledWith("two", change === "environment" ? "prod" : "dev");
  });
});
