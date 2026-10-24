import { beforeEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only composition has no declaration surface.
import { createMemoryEmbeddingConnectionFeature } from "../../web-ui/app/components/long-term-memory/embedding-connection-feature.js";
import type { MemoryEmbeddingDialogDependencies } from "../../web-ui/app/components/long-term-memory/embedding-connection-dialog.js";

const dialog = vi.hoisted(() => ({
  dependencies: null as MemoryEmbeddingDialogDependencies | null,
  create: vi.fn(),
  open: vi.fn(),
  isOpen: vi.fn(),
  environmentChanged: vi.fn(),
}));

vi.mock(
  "../../web-ui/app/components/long-term-memory/embedding-connection-dialog.js",
  () => ({
    createMemoryEmbeddingConnectionDialog: (
      dependencies: MemoryEmbeddingDialogDependencies,
    ) => {
      dialog.dependencies = dependencies;
      dialog.create(dependencies);
      return {
        open: dialog.open,
        isOpen: dialog.isOpen,
        environmentChanged: dialog.environmentChanged,
      };
    },
  }),
);

beforeEach(() => {
  dialog.dependencies = null;
  dialog.create.mockClear();
  dialog.open.mockReset().mockResolvedValue(true);
  dialog.isOpen.mockReset().mockReturnValue(false);
  dialog.environmentChanged.mockClear();
});

const provider = { id: "llamacpp-embedding", type: "llamacpp" };
const status = {
  enabled: true,
  providerId: provider.id,
  providers: [provider],
};
const credential = {
  ...provider,
  credentialConfigured: true,
  requiresApiKey: true,
};
const connection = Object.freeze({
  provider: "llamacpp" as const,
  newProviderId: provider.id,
  model: "fixture-embedding",
  baseUrl: "http://127.0.0.1:8081",
  useApiKey: true,
  apiKey: "synthetic-feature-key",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fixture() {
  let environment = "dev";
  const workspace = {
    beginExternalRuntimeMutation: vi.fn(() => true),
    endExternalRuntimeMutation: vi.fn(),
    refreshAfterExternalRuntimeMutation: vi.fn(async () => true),
  };
  const runtimeClient = {
    loadLongTermMemoryStatus: vi.fn(async (_environmentId: string) => ({
      status,
    })),
    loadModelSetup: vi.fn(async (_environmentId: string) => ({
      providers: [credential],
    })),
    saveMemoryEmbeddingConnection: vi.fn(
      async (_input: Record<string, unknown>, _environmentId: string) =>
        ({ status }) as Record<string, unknown>,
    ),
    discoverLongTermMemoryModels: vi.fn(
      async (_input: Record<string, unknown>) => ({ catalog: { models: [] } }),
    ),
    applyRuntimeConfiguration: vi.fn(async (_environmentId: string) => ({
      activation: { status: "ready" },
    })),
  };
  const callbacks = { onSaved: vi.fn(), onApplied: vi.fn(), onClosed: vi.fn() };
  const canOpen = vi.fn(() => true);
  const feature = createMemoryEmbeddingConnectionFeature({
    root: {} as HTMLElement,
    runtimeClient,
    getEnvironmentId: () => environment,
    getWorkspace: () => workspace,
    canOpen,
    ...callbacks,
  });
  return {
    feature,
    runtimeClient,
    workspace,
    callbacks,
    canOpen,
    setEnvironment: (id: string) => {
      environment = id;
    },
  };
}

function dependencies() {
  expect(dialog.dependencies).not.toBeNull();
  return dialog.dependencies!;
}

describe("Memory connection feature composition", () => {
  test("creates its dialog lazily, checks dirty configuration first, and reuses the instance", async () => {
    const f = fixture();
    expect(dialog.create).not.toHaveBeenCalled();
    f.workspace.beginExternalRuntimeMutation.mockReturnValue(false);
    await expect(f.feature.open({ emitClientEvents: true })).resolves.toBe(
      false,
    );
    expect(f.workspace.beginExternalRuntimeMutation).toHaveBeenCalledWith(
      "embedding connection",
    );
    expect(f.workspace.endExternalRuntimeMutation).not.toHaveBeenCalled();
    expect(dialog.create).not.toHaveBeenCalled();
    f.workspace.beginExternalRuntimeMutation.mockReturnValue(true);
    const options = { profileId: "existing-memory", emitClientEvents: true };
    await expect(f.feature.open(options)).resolves.toBe(true);
    expect(dialog.create).toHaveBeenCalledOnce();
    expect(dialog.open).toHaveBeenCalledWith(options);
    expect(f.workspace.endExternalRuntimeMutation).toHaveBeenCalledOnce();
    await f.feature.open(options);
    expect(dialog.create).toHaveBeenCalledOnce();
    expect(dialog.open).toHaveBeenCalledTimes(2);
  });

  test("readiness and an open dialog prevent additional mutations or dialogs", async () => {
    const f = fixture();
    f.canOpen.mockReturnValue(false);
    await expect(f.feature.open()).resolves.toBe(false);
    expect(f.workspace.beginExternalRuntimeMutation).not.toHaveBeenCalled();
    f.canOpen.mockReturnValue(true);
    await f.feature.open();
    dialog.isOpen.mockReturnValue(true);
    const calls = f.workspace.beginExternalRuntimeMutation.mock.calls.length;
    await expect(f.feature.open()).resolves.toBe(false);
    expect(f.workspace.beginExternalRuntimeMutation).toHaveBeenCalledTimes(
      calls,
    );
    expect(dialog.create).toHaveBeenCalledOnce();
    expect(f.feature.isOpen()).toBe(true);
  });

  test("projects credential flags from the matching catalog for the requested environment", async () => {
    const f = fixture();
    await f.feature.open();
    f.setEnvironment("prod");
    const payload = await dependencies().loadStatus("dev");
    expect(f.runtimeClient.loadLongTermMemoryStatus).toHaveBeenCalledWith(
      "dev",
    );
    expect(f.runtimeClient.loadModelSetup).toHaveBeenCalledWith("dev");
    expect(payload.status.providers).toEqual([credential]);
    expect(status.providers).toEqual([provider]);
  });

  test("saves memory options through the settings endpoint and clears the request secret while keeping its original environment", async () => {
    const f = fixture();
    const pending = deferred<Record<string, unknown>>();
    f.runtimeClient.saveMemoryEmbeddingConnection.mockReturnValue(
      pending.promise,
    );
    await f.feature.open();
    const options = { emitClientEvents: false, profileId: "existing-memory" };
    const saving = dependencies().saveConnection(connection, options, "dev");
    expect(f.runtimeClient.saveMemoryEmbeddingConnection).toHaveBeenCalledWith(
      { ...connection, ...options },
      "dev",
    );
    const request =
      f.runtimeClient.saveMemoryEmbeddingConnection.mock.calls[0]![0];
    expect(request.apiKey).toBe(connection.apiKey);
    f.setEnvironment("prod");
    pending.resolve({ status, restartRequired: true });
    const payload = await saving;
    expect(payload).toMatchObject({
      restartRequired: true,
      status: { providers: [credential] },
    });
    expect(request).not.toHaveProperty("apiKey");
    expect(connection.apiKey).toBe("synthetic-feature-key");
    expect(f.runtimeClient.loadModelSetup).toHaveBeenCalledExactlyOnceWith(
      "dev",
    );
    expect(
      f.runtimeClient.saveMemoryEmbeddingConnection,
    ).toHaveBeenCalledOnce();
  });

  test("decorates a partial-save failure receipt and removes the request secret on failure", async () => {
    const f = fixture();
    const failure = Object.assign(new Error("Embedding check failed."), {
      payload: { providerSaved: true, savedProvider: { ...provider } },
    });
    f.runtimeClient.saveMemoryEmbeddingConnection.mockRejectedValue(failure);
    await f.feature.open();
    await expect(
      dependencies().saveConnection(
        connection,
        { emitClientEvents: true },
        "dev",
      ),
    ).rejects.toBe(failure);
    const request =
      f.runtimeClient.saveMemoryEmbeddingConnection.mock.calls[0]![0];
    expect(request).not.toHaveProperty("apiKey");
    expect(failure.payload.savedProvider).toEqual(credential);
    expect(f.runtimeClient.loadModelSetup).toHaveBeenCalledExactlyOnceWith(
      "dev",
    );
  });

  test("preserves canonical receipt identity when credential catalog lookup fails", async () => {
    const f = fixture();
    const failure = Object.assign(new Error("Embedding check failed."), {
      payload: { providerSaved: true, savedProvider: { ...provider } },
    });
    f.runtimeClient.saveMemoryEmbeddingConnection.mockRejectedValue(failure);
    f.runtimeClient.loadModelSetup.mockRejectedValue(
      new Error("Catalog unavailable."),
    );
    await f.feature.open();
    await expect(
      dependencies().saveConnection(connection, {}, "dev"),
    ).rejects.toBe(failure);
    expect(failure.payload.savedProvider).toEqual(provider);
    expect(
      f.runtimeClient.saveMemoryEmbeddingConnection.mock.calls[0]![0],
    ).not.toHaveProperty("apiKey");
  });

  test("composes workspace locking, refresh, apply and lifecycle callbacks without triggering them during construction", async () => {
    const f = fixture();
    f.feature.environmentChanged();
    expect(dialog.environmentChanged).not.toHaveBeenCalled();
    await f.feature.open();
    const options = dependencies();
    expect(options.onSaved).toBe(f.callbacks.onSaved);
    expect(options.onApplied).toBe(f.callbacks.onApplied);
    expect(options.onClosed).toBe(f.callbacks.onClosed);
    expect(f.runtimeClient.applyRuntimeConfiguration).not.toHaveBeenCalled();
    expect(options.beginRuntimeMutation?.("dev")).toBe(true);
    options.endRuntimeMutation?.("dev");
    await options.refreshRuntimeConfig?.("dev");
    expect(
      f.workspace.refreshAfterExternalRuntimeMutation,
    ).toHaveBeenCalledWith("Embedding connection saved; refresh required");
    await options.applyConfiguration("dev");
    expect(f.runtimeClient.applyRuntimeConfiguration).toHaveBeenCalledWith(
      "dev",
    );
    await options.discoverModels(provider.id, "dev");
    expect(f.runtimeClient.discoverLongTermMemoryModels).toHaveBeenCalledWith({
      providerId: provider.id,
      environmentId: "dev",
    });
    f.feature.environmentChanged();
    expect(dialog.environmentChanged).toHaveBeenCalledOnce();
  });
});
