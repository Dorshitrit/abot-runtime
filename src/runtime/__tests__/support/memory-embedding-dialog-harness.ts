import { vi } from "vitest";
import {
  createMemoryEmbeddingConnectionDialog,
  type MemoryEmbeddingDialogDependencies,
} from "../../../web-ui/app/components/long-term-memory/embedding-connection-dialog.js";
import { FakeElement } from "./model-setup-wizard-harness.js";

export const memoryEmbeddingProviders = [
  { id: "cloud", type: "openai", credentialConfigured: true },
  { id: "local", type: "ollama" },
  { id: "chat", type: "llamacpp", requiresApiKey: false },
];
export const embeddingSuccess = (providerId = "llamacpp-embedding") => ({
  status: {
    enabled: true,
    providerId,
    model: "embedding-model",
    providers: [
      ...memoryEmbeddingProviders,
      { id: providerId, type: "llamacpp", requiresApiKey: false },
    ],
  },
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
export function createMemoryEmbeddingDialogHarness(
  overrides: Partial<MemoryEmbeddingDialogDependencies> = {},
) {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  document.documentElement.append(document.body);
  document.activeElement = document.body;
  const root = document.createElement("section");
  document.body.append(root);
  let environment = "dev";
  let locked = false;
  const requests: Array<Record<string, any>> = [];
  const dependencies = {
    loadStatus: vi.fn(async () => ({
      status: {
        enabled: true,
        providerId: "local",
        model: "old-embedding",
        providers: memoryEmbeddingProviders,
      },
    })),
    saveConnection: vi.fn(
      async (
        input: Record<string, any>,
        options: Record<string, any>,
        id: string,
      ) => {
        requests.push({
          input: { ...input },
          options: { ...options },
          environmentId: id,
        });
        return embeddingSuccess(input.providerId || input.newProviderId);
      },
    ),
    discoverModels: vi.fn(async () => ({
      catalog: { supported: false, models: [] },
    })),
    beginRuntimeMutation: vi.fn(() => {
      if (locked) return false;
      locked = true;
      return true;
    }),
    endRuntimeMutation: vi.fn(() => {
      locked = false;
    }),
    refreshRuntimeConfig: vi.fn(async () => true),
    onSaved: vi.fn(),
    onApplied: vi.fn(async () => true),
    applyConfiguration: vi.fn(async () => ({
      activation: { status: "ready" },
    })),
    onClosed: vi.fn(),
  };
  const controller = createMemoryEmbeddingConnectionDialog({
    root: root as unknown as HTMLElement,
    getEnvironmentId: () => environment,
    ...dependencies,
    ...overrides,
  });
  const dialog = root.querySelector("dialog")!;
  const field = (name: string) =>
    dialog.querySelector(`[data-runtime-setup-field="${name}"]`)!;
  const input = (name: string, value: string) => {
    const node = field(name);
    node.value = value;
    node.dispatch("input");
  };
  const choose = (value: string) => {
    const node = field("embedding-provider");
    node.value = value;
    node.dispatch("change");
  };
  const click = (action: string) =>
    dialog
      .querySelector(`[data-memory-connection-action="${action}"]`)
      ?.dispatch("click");
  const submit = () => dialog.querySelector("form")!.dispatch("submit");
  const ready = async () => vi.waitFor(() => expectIdle());
  function expectIdle() {
    if (dialog.innerHTML.includes('aria-busy="true"')) throw new Error("Busy");
  }
  const fill = () => {
    choose("new:llamacpp");
    input("embedding-model", "embedding-model");
    input("embedding-url", "http://embedding-server:8081");
  };
  return {
    controller,
    dialog,
    field,
    input,
    choose,
    click,
    submit,
    ready,
    fill,
    requests,
    dependencies,
    changeEnvironment: (value: string) => {
      environment = value;
      controller.environmentChanged();
    },
    isLocked: () => locked,
  };
}
