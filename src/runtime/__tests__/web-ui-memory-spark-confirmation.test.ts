import { expect, test, vi } from "vitest";
// @ts-expect-error Browser component has no declaration surface.
import { createLongTermMemoryManager } from "../../web-ui/app/components/long-term-memory/manager.js";
// @ts-expect-error Browser component has no declaration surface.
import { createSparkChatSettings } from "../../web-ui/app/components/spark-chat/settings.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function rootElement() {
  const doc = {} as ConstructorParameters<typeof FakeElement>[1];
  doc.createElement = (tag) => new FakeElement(tag, doc);
  doc.documentElement = doc.createElement("html");
  doc.body = doc.createElement("body");
  return doc.createElement("section");
}
function deferredApproval() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((yes) => { resolve = yes; });
  return { resolve, confirm: vi.fn(() => promise) };
}

test.each(["cancel", "environment", "record", "approve"] as const)(
  "memory deletion waits and rechecks %s", async (change) => {
    const root = rootElement();
    const approval = deferredApproval();
    let environment = "dev";
    const record = { id: "memory", content: "Kept memory", tags: [], origin: "web_ui",
      createdAt: "2026-10-01", updatedAt: "2026-10-01" };
    const snapshot = { items: [record], enabled: true, available: true, total: 1, offset: 0,
      query: "", originFilter: "", loading: false, mutation: false, editor: null, error: "", message: "" };
    const deleteMemory = vi.fn(async () => {});
    const view = createLongTermMemoryManager({ actions: { snapshot: () => snapshot, deleteMemory },
      getEnvironmentId: () => environment, confirmDelete: approval.confirm });
    view.mount(root);
    root.querySelector('[data-memory-management-action="delete"]')!.dispatch("click");
    expect(approval.confirm).toHaveBeenCalledOnce();
    expect(deleteMemory).not.toHaveBeenCalled();
    if (change === "environment") environment = "prod";
    if (change === "record") snapshot.items = [{ ...record, content: "Newer memory", updatedAt: "2026-10-02" }];
    approval.resolve(change !== "cancel");
    await Promise.resolve();
    expect(deleteMemory).toHaveBeenCalledTimes(change === "approve" ? 1 : 0);
    if (change === "approve") expect(deleteMemory).toHaveBeenCalledWith("memory");
  },
);

test.each(["cancel", "environment", "conversation", "roundtrip", "approve"] as const)(
  "SPARK clear waits and rechecks %s", async (change) => {
    const root = rootElement();
    const approval = deferredApproval();
    const onClear = vi.fn(async () => {});
    const configuration = { sessionId: "spark-1", toolPermissionMode: "ask" };
    const settings = createSparkChatSettings({
      root: { querySelector: () => ({ prepend: (card: FakeElement) => root.append(card) }) },
      documentRoot: root.ownerDocument, onClear, onSave: vi.fn(), onOpen: vi.fn(),
      getAgentMode: () => "fast", getWebConfig: () => ({}), confirmClear: approval.confirm,
    });
    settings.render(configuration, "dev");
    root.querySelector("[data-spark-clear]")!.dispatch("click");
    expect(approval.confirm).toHaveBeenCalledOnce();
    expect(onClear).not.toHaveBeenCalled();
    if (change === "environment" || change === "roundtrip") settings.render(configuration, "prod");
    if (change === "roundtrip") settings.render(configuration, "dev");
    if (change === "conversation") settings.render({ ...configuration, sessionId: "spark-2" }, "dev");
    approval.resolve(change !== "cancel");
    await Promise.resolve();
    expect(onClear).toHaveBeenCalledTimes(change === "approve" ? 1 : 0);
  },
);
