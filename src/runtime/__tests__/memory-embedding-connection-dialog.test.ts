import { expect, test, vi } from "vitest";
import {
  createMemoryEmbeddingDialogHarness,
  embeddingSuccess,
  memoryEmbeddingProviders,
  deferred,
} from "./support/memory-embedding-dialog-harness.js";

test("adds a separate no-auth embedding connection and applies only on explicit action", async () => {
  const h = createMemoryEmbeddingDialogHarness();
  await h.controller.open({ emitClientEvents: true, profileId: "memory" });
  expect(h.dialog.innerHTML).toContain('value="new:llamacpp" selected');
  expect(h.dependencies.saveConnection).not.toHaveBeenCalled();
  h.fill();
  h.submit();
  await h.ready();
  expect(h.requests).toEqual([
    {
      input: {
        provider: "llamacpp",
        newProviderId: "llamacpp-embedding",
        useApiKey: false,
        baseUrl: "http://embedding-server:8081",
        model: "embedding-model",
      },
      options: { emitClientEvents: true, profileId: "memory" },
      environmentId: "dev",
    },
  ]);
  expect(h.dependencies.onSaved).toHaveBeenCalledOnce();
  expect(h.dependencies.refreshRuntimeConfig).toHaveBeenCalledWith("dev");
  expect(h.dependencies.applyConfiguration).not.toHaveBeenCalled();
  expect(h.dialog.innerHTML).toContain("Embedding connection saved");
  expect(h.controller.isOpen()).toBe(true);
  h.click("apply");
  await vi.waitFor(() => expect(h.controller.isOpen()).toBe(false));
  expect(h.dependencies.applyConfiguration).toHaveBeenCalledWith("dev");
  expect(h.dependencies.onApplied).toHaveBeenCalledOnce();
  expect(h.dependencies.onClosed).toHaveBeenCalledWith({ completed: true });
});

test("selects the first offered new provider dynamically", async () => {
  const h = createMemoryEmbeddingDialogHarness({
    loadStatus: async () => ({ status: { providers: [] } }),
  });
  await h.controller.open();
  expect(h.dialog.innerHTML).toContain('value="new:openai" selected');
});

test("sends a key only with save and clears retained references and the dialog on close", async () => {
  let request: Record<string, unknown> | undefined;
  let submitted: Record<string, unknown> | undefined;
  const saveConnection = vi.fn(async (input) => {
    request = input;
    submitted = { ...input };
    return embeddingSuccess();
  });
  const h = createMemoryEmbeddingDialogHarness({ saveConnection });
  await h.controller.open({ emitClientEvents: false });
  h.fill();
  h.input("embedding-key", "synthetic-credential");
  expect(h.dialog.innerHTML).not.toContain("synthetic-credential");
  h.submit();
  await h.ready();
  expect(saveConnection).toHaveBeenCalledOnce();
  expect(submitted).toMatchObject({
    apiKey: "synthetic-credential",
    useApiKey: true,
  });
  expect(request).not.toHaveProperty("apiKey");
  expect(h.dialog.innerHTML).not.toContain("synthetic-credential");
  expect(h.controller.close()).toBe(true);
  expect(h.dialog.innerHTML).toBe("");
});

test("refreshes a saved provider after failed probe and retries the receipt without a secret", async () => {
  const requests: Record<string, unknown>[] = [];
  const saveConnection = vi.fn(async (input) => {
    requests.push({ ...input });
    if (requests.length === 1)
      throw Object.assign(new Error("upstream details"), {
        payload: {
          providerSaved: true,
          message: "Embedding probe failed.",
          savedProvider: {
            id: "llamacpp-embedding",
            type: "llamacpp",
            credentialConfigured: true,
            requiresApiKey: true,
          },
        },
      });
    return embeddingSuccess();
  });
  const h = createMemoryEmbeddingDialogHarness({ saveConnection });
  await h.controller.open();
  h.fill();
  h.input("embedding-key", "synthetic-credential");
  h.submit();
  await h.ready();
  expect(h.dependencies.onSaved).toHaveBeenCalledOnce();
  expect(h.dependencies.refreshRuntimeConfig).toHaveBeenCalledOnce();
  expect(h.dialog.innerHTML).toContain('value="llamacpp-embedding" selected');
  expect(h.dialog.innerHTML).toContain("memory is unchanged");
  expect(h.field("embedding-key").value).toBe("");
  h.submit();
  await h.ready();
  expect(requests[1]).toEqual({
    providerId: "llamacpp-embedding",
    model: "embedding-model",
  });
  expect(h.dependencies.onSaved).toHaveBeenCalledTimes(2);
});

test("does not acquire a write or discard a key before explicit submit", async () => {
  const h = createMemoryEmbeddingDialogHarness();
  await h.controller.open();
  h.fill();
  h.input("embedding-key", "synthetic-credential");
  expect(h.dependencies.beginRuntimeMutation).not.toHaveBeenCalled();
  expect(h.field("embedding-key").value).toBe("synthetic-credential");
  h.controller.close();
  expect(h.dependencies.saveConnection).not.toHaveBeenCalled();
  expect(h.dialog.innerHTML).toBe("");
});

test("denies saving when configuration is locked", async () => {
  const h = createMemoryEmbeddingDialogHarness({
    beginRuntimeMutation: () => false,
  });
  await h.controller.open();
  h.fill();
  h.submit();
  await h.ready();
  expect(h.dependencies.saveConnection).not.toHaveBeenCalled();
  expect(h.dependencies.endRuntimeMutation).not.toHaveBeenCalled();
  expect(h.dialog.innerHTML).toContain("Save or reset configuration changes");
});

test("keeps mutation ownership through canonical configuration refresh", async () => {
  const refresh = deferred<boolean>();
  const h = createMemoryEmbeddingDialogHarness({
    refreshRuntimeConfig: () => refresh.promise,
  });
  await h.controller.open();
  h.fill();
  h.submit();
  await vi.waitFor(() => expect(h.dependencies.onSaved).toHaveBeenCalledOnce());
  expect(h.isLocked()).toBe(true);
  expect(h.controller.close()).toBe(false);
  expect(h.dependencies.endRuntimeMutation).not.toHaveBeenCalled();
  refresh.resolve(true);
  await h.ready();
  expect(h.isLocked()).toBe(false);
  expect(h.dependencies.endRuntimeMutation).toHaveBeenCalledOnce();
});

test("an unchanged existing choice closes without reporting a new saved configuration", async () => {
  const h = createMemoryEmbeddingDialogHarness({
    loadStatus: async () => ({
      status: {
        ...embeddingSuccess("chat").status,
        providers: memoryEmbeddingProviders,
      },
    }),
  });
  await h.controller.open();
  h.choose("chat");
  h.input("embedding-model", "embedding-model");
  h.submit();
  await vi.waitFor(() => expect(h.controller.isOpen()).toBe(false));
  expect(h.dependencies.saveConnection).not.toHaveBeenCalled();
  expect(h.dependencies.onSaved).not.toHaveBeenCalled();
  expect(h.dependencies.applyConfiguration).not.toHaveBeenCalled();
});

test("retrying a failed option load still starts with a new connection", async () => {
  const loadStatus = vi
    .fn()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce({ status: { providers: memoryEmbeddingProviders } });
  const h = createMemoryEmbeddingDialogHarness({ loadStatus });
  expect(await h.controller.open()).toBe(false);
  h.dialog
    .querySelector('[data-runtime-setup-action="embedding-reload"]')!
    .dispatch("click");
  await h.ready();
  expect(h.dialog.innerHTML).toContain('value="new:llamacpp" selected');
  expect(loadStatus).toHaveBeenCalledTimes(2);
});
