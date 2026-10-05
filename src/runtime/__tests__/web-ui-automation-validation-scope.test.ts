import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  let environment = "dev", revision = 1;
  const client = {
    supportsAutomations: () => true,
    listAutomations: vi.fn(async () => ({ automations: [{ id: "one" }, { id: "two" }] })),
    getAutomationCatalog: vi.fn(async () => ({ operations: [], models: [], savedAgents: [] })),
    getAutomationDraft: vi.fn(async (id: string) => ({ draft: { automationId: id, revision,
      definition: { title: id, body: { kind: "sequence", id: "root", children: [] } } } })),
    listAutomationRuns: vi.fn(async () => ({ runs: [] })),
    validateAutomation: vi.fn(async (_id: string, _environment: string) => ({ issues: [] as unknown[] })),
  };
  const controller = createAutomationsController({ client, getEnvironmentId: () => environment,
    render: vi.fn(), isVisible: () => true });
  return { client, controller, setEnvironment(value: string) { environment = value; },
    advanceRevision() { revision += 1; } };
}

async function changeView(f: ReturnType<typeof fixture>, destination: string) {
  if (destination === "environment") {
    f.setEnvironment("prod");
    f.controller.environmentChanged();
    await f.controller.openRoute("one");
  } else if (destination === "draft revision") {
    f.advanceRevision();
    await f.controller.refresh();
  } else {
    await f.controller.openRoute("two");
    if (destination === "away and back") await f.controller.openRoute("one");
  }
}

describe("automation validation view ownership", () => {
  const cases = ["automation", "environment", "away and back", "draft revision"]
    .flatMap((destination) => ["success", "failure"].map((outcome) => ({ destination, outcome })));
  test.each(cases)("discards validation $outcome after changing $destination", async ({ destination, outcome }) => {
    const f = fixture();
    await f.controller.openRoute("one");
    const held = deferred<{ issues: unknown[] }>();
    f.client.validateAutomation.mockImplementationOnce(() => held.promise);
    const validation = f.controller.validate();
    expect(f.client.validateAutomation).toHaveBeenCalledExactlyOnceWith("one", "dev");
    await changeView(f, destination);
    const before = f.controller.snapshot();
    if (outcome === "success") held.resolve({ issues: [{ code: "old_issue", path: "trigger", message: "Old issue" }] });
    else held.reject(new Error("Old validation failed"));
    expect(await validation).toBe(false);
    expect(f.controller.snapshot()).toEqual({ ...before, mutation: "" });
  });

  test("discards a result after the environment changes before its reset notification", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    const held = deferred<{ issues: unknown[] }>();
    f.client.validateAutomation.mockImplementationOnce(() => held.promise);
    const validation = f.controller.validate();
    const before = f.controller.snapshot();
    f.setEnvironment("prod");
    held.resolve({ issues: [] });
    expect(await validation).toBe(false);
    expect(f.controller.snapshot()).toEqual({ ...before, mutation: "" });
  });

  test("shows successful validation for the current draft", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    expect(await f.controller.validate()).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ validation: { issues: [] }, validationVisible: true,
      feedback: "Check complete. Ready to publish.", error: "", mutation: "" });
  });

  test("shows a current failure and never validates an unselected draft", async () => {
    const f = fixture();
    expect(await f.controller.validate()).toBe(false);
    expect(f.client.validateAutomation).not.toHaveBeenCalled();
    await f.controller.openRoute("one");
    f.client.validateAutomation.mockRejectedValueOnce(new Error("Validation failed"));
    expect(await f.controller.validate()).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ error: "Validation failed", mutation: "", validationVisible: false });
  });
});
