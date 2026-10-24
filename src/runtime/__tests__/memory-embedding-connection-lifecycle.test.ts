import { expect, test, vi } from "vitest";
import {
  createMemoryEmbeddingDialogHarness,
  deferred,
  embeddingSuccess,
} from "./support/memory-embedding-dialog-harness.js";

test("environment replacement clears a pending load and ignores its result", async () => {
  const load = deferred<Record<string, unknown>>();
  const h = createMemoryEmbeddingDialogHarness({
    loadStatus: () => load.promise,
  });
  const opened = h.controller.open();
  h.changeEnvironment("prod");
  expect(h.controller.isOpen()).toBe(false);
  expect(h.dialog.innerHTML).toBe("");
  load.resolve(embeddingSuccess());
  expect(await opened).toBe(false);
  expect(h.dependencies.onSaved).not.toHaveBeenCalled();
  expect(h.dependencies.refreshRuntimeConfig).not.toHaveBeenCalled();
});

test("a stale save cannot mark, refresh, or release a new environment's mutation", async () => {
  const oldSave = deferred<Record<string, unknown>>();
  const newSave = deferred<Record<string, unknown>>();
  const saveConnection = vi
    .fn()
    .mockReturnValueOnce(oldSave.promise)
    .mockReturnValueOnce(newSave.promise);
  const h = createMemoryEmbeddingDialogHarness({ saveConnection });
  await h.controller.open();
  h.fill();
  h.input("embedding-key", "synthetic-secret");
  h.submit();
  expect(h.isLocked()).toBe(true);
  h.changeEnvironment("prod");
  expect(h.isLocked()).toBe(false);
  expect(h.dialog.innerHTML).toBe("");
  await h.controller.open();
  h.fill();
  h.submit();
  expect(h.isLocked()).toBe(true);
  oldSave.resolve(embeddingSuccess("old-embedding"));
  await Promise.resolve();
  await Promise.resolve();
  expect(h.dependencies.onSaved).not.toHaveBeenCalled();
  expect(h.dependencies.refreshRuntimeConfig).not.toHaveBeenCalled();
  expect(h.dependencies.endRuntimeMutation).toHaveBeenCalledTimes(1);
  expect(h.isLocked()).toBe(true);
  newSave.resolve(embeddingSuccess("new-embedding"));
  await h.ready();
  expect(h.dependencies.endRuntimeMutation).toHaveBeenCalledTimes(2);
  expect(h.dependencies.onSaved).toHaveBeenCalledWith(
    expect.objectContaining({
      status: expect.objectContaining({ providerId: "new-embedding" }),
    }),
    "prod",
  );
});

test("unavailable activation leaves saved settings pending and offers another explicit apply", async () => {
  const applyConfiguration = vi
    .fn()
    .mockResolvedValueOnce({ activation: { status: "restart_required" } })
    .mockResolvedValueOnce({ activation: { status: "ready" } });
  const h = createMemoryEmbeddingDialogHarness({ applyConfiguration });
  await h.controller.open();
  h.fill();
  h.submit();
  await h.ready();
  h.click("apply");
  await h.ready();
  expect(h.controller.isOpen()).toBe(true);
  expect(h.dependencies.onApplied).not.toHaveBeenCalled();
  expect(h.dialog.innerHTML).toContain("could not apply them yet");
  expect(h.dependencies.saveConnection).toHaveBeenCalledOnce();
  h.click("apply");
  await vi.waitFor(() => expect(h.controller.isOpen()).toBe(false));
  expect(applyConfiguration).toHaveBeenCalledTimes(2);
  expect(h.dependencies.saveConnection).toHaveBeenCalledOnce();
});

test("a stale apply cannot mark the new environment as applied", async () => {
  const applyResult = deferred<Record<string, unknown>>();
  const h = createMemoryEmbeddingDialogHarness({
    applyConfiguration: () => applyResult.promise,
  });
  await h.controller.open();
  h.fill();
  h.submit();
  await h.ready();
  h.click("apply");
  expect(h.controller.close()).toBe(false);
  h.changeEnvironment("prod");
  applyResult.resolve({ activation: { status: "ready" } });
  await Promise.resolve();
  await Promise.resolve();
  expect(h.dependencies.onApplied).not.toHaveBeenCalled();
  expect(h.dependencies.refreshRuntimeConfig).toHaveBeenCalledTimes(1);
  expect(h.controller.isOpen()).toBe(false);
});

test("ready activation with a failed config refresh stays open and does not report completion", async () => {
  const refreshRuntimeConfig = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  const h = createMemoryEmbeddingDialogHarness({ refreshRuntimeConfig });
  await h.controller.open();
  h.fill();
  h.submit();
  await h.ready();
  h.click("apply");
  await h.ready();
  expect(h.controller.isOpen()).toBe(true);
  expect(h.dependencies.onApplied).toHaveBeenCalledOnce();
  expect(h.dependencies.onClosed).not.toHaveBeenCalled();
  expect(h.dialog.innerHTML).toContain("Refresh Memory settings");
});
