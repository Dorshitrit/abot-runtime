import { vi } from "vitest";
import {
  createRuntimeSetupGuide,
  type RuntimeSetupGuideDependencies,
  type RuntimeSetupInput,
  type RuntimeSetupSnapshot,
} from "../../../web-ui/app/components/runtime-setup-guide.js";

export const setupSnapshot: RuntimeSetupSnapshot = {
  status: "required",
  configExists: false,
  defaultContextWindowTokens: 32768,
  providers: [
    {
      id: "openai",
      label: "OpenAI",
      requiresApiKey: true,
      credentialConfigured: false,
    },
    {
      id: "ollama",
      label: "Ollama",
      requiresApiKey: false,
      credentialConfigured: false,
    },
  ],
};

export function createGuideHarness(
  overrides: Partial<RuntimeSetupGuideDependencies> = {},
) {
  const listeners = new Map<string, (event: any) => void>();
  const action = { focus: vi.fn() };
  const title = { focus: vi.fn() };
  const fields = Object.fromEntries(
    [
      "provider",
      "model-id",
      "context-window",
      "ollama-base-url",
      "api-key",
      "embedding-provider",
      "embedding-model",
      "embedding-url",
      "embedding-key",
    ].map((id) => [
      id,
      {
        value: "",
        dataset: { runtimeSetupField: id },
        focus: vi.fn(),
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
      },
    ]),
  );
  const submissions: RuntimeSetupInput[] = [];
  const loadSetup = vi.fn(async () => ({ setup: setupSnapshot }));
  const applySetup = vi.fn(async () => ({
    activation: { status: "ready" as const },
  }));
  const saveSetup = vi.fn(async (input: RuntimeSetupInput) => {
    submissions.push({ ...input });
    return { setup: setupSnapshot, activation: { status: "ready" as const } };
  });
  const loadEmbeddingStatus = vi.fn(async () => ({
    status: { enabled: false, providers: [{ id: "ollama", type: "ollama" }] },
  }));
  const discoverEmbeddingModels = vi.fn(async () => ({
    catalog: { supported: true, models: ["embedding-test"] },
  }));
  const saveEmbedding = vi.fn(async (input: Record<string, unknown>) => ({
    status: {
      enabled: true,
      providerId: input.providerId || input.provider,
      model: input.model,
      providers: [{ id: "ollama", type: "ollama" }],
    },
  }));
  const loadPlugins = vi.fn(async () => ({
    plugins: [],
    selection: { enabled: true, allow: ["*"], deny: [] },
  }));
  const setPlugin = vi.fn(async () => ({ plugins: [] }));
  let markup = "";
  const pluginElements = new Map<string, any[]>();
  const container = {
    hidden: true,
    get innerHTML() {
      return markup;
    },
    set innerHTML(value: string) {
      markup = value;
      pluginElements.clear();
      for (const input of value.matchAll(/<input\b[^>]*>/g)) {
        const name = input[0].match(/data-runtime-setup-field="([^"]+)"/)?.[1];
        if (name && fields[name])
          fields[name].value = input[0].match(/value="([^"]*)"/)?.[1] || "";
      }
    },
    scrollTop: 0,
    addEventListener: vi.fn((name: string, listener: (event: any) => void) =>
      listeners.set(name, listener),
    ),
    querySelectorAll: vi.fn((selector: string) => {
      if (pluginElements.has(selector)) return pluginElements.get(selector)!;
      const attribute = selector.slice(1, -1);
      const elements = [...markup.matchAll(/<(?:input|button)\b[^>]*>/g)]
        .filter((match) => match[0].includes(attribute + "="))
        .map((match) => {
          const dataset = Object.fromEntries(
            [...match[0].matchAll(/data-([a-z-]+)="([^"]*)"/g)].map((entry) => [
              entry[1].replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
              entry[2],
            ]),
          );
          const handlers = new Map<string, () => void>();
          return {
            dataset,
            checked: /\schecked(?:\s|>)/.test(match[0]),
            disabled: /\sdisabled(?:\s|\/>|>)/.test(match[0]),
            focus: vi.fn(),
            addEventListener: (name: string, handler: () => void) =>
              handlers.set(name, handler),
            dispatch: (name: string) => handlers.get(name)?.(),
          };
        });
      pluginElements.set(selector, elements);
      return elements;
    }),
    querySelector: vi.fn((selector: string) => {
      if (selector === '[data-runtime-setup-action="check"]') return action;
      if (selector === "[data-runtime-setup-title]") return title;
      const field = selector.match(/data-runtime-setup-field="([^"]+)"/)?.[1];
      if (field) return fields[field];
      return null;
    }),
    replaceChildren: vi.fn(() => {
      container.innerHTML = "";
    }),
  };
  const conversationRegion = { hidden: false };
  const guide = createRuntimeSetupGuide({
    container: container as never,
    conversationRegion: conversationRegion as never,
    loadSetup,
    saveSetup,
    applySetup,
    loadEmbeddingStatus,
    discoverEmbeddingModels,
    saveEmbedding,
    loadPlugins,
    setPlugin,
    ...overrides,
  });

  function dispatch(
    eventName: string,
    dataset: Record<string, string>,
    value = "",
  ) {
    const field = fields[dataset.runtimeSetupField];
    const target = Object.assign(field || {}, {
      dataset,
      value,
      closest: () => target,
    });
    listeners.get(eventName)?.({ target, preventDefault: vi.fn() });
  }

  async function ready() {
    await vi.waitFor(() => {
      if (container.innerHTML.includes('aria-busy="true"'))
        throw new Error("Loading");
    });
  }

  async function open() {
    guide.bind();
    guide.render({ status: "setup_required", showGuide: true });
    await ready();
  }

  return {
    action,
    title,
    container,
    conversationRegion,
    fields,
    guide,
    loadSetup,
    saveSetup,
    applySetup,
    submissions,
    loadEmbeddingStatus,
    discoverEmbeddingModels,
    saveEmbedding,
    loadPlugins,
    setPlugin,
    ready,
    open,
    changeProvider: (value: string) =>
      dispatch("change", { runtimeSetupField: "provider" }, value),
    inputModel: (value: string) =>
      dispatch("input", { runtimeSetupField: "model-id" }, value),
    inputContextWindow: (value: string) =>
      dispatch("input", { runtimeSetupField: "context-window" }, value),
    inputBaseUrl: (value: string) =>
      dispatch("input", { runtimeSetupField: "ollama-base-url" }, value),
    inputKey: (value: string) =>
      dispatch("input", { runtimeSetupField: "api-key" }, value),
    inputEmbeddingModel: (value: string) =>
      dispatch("input", { runtimeSetupField: "embedding-model" }, value),
    inputEmbeddingKey: (value: string) =>
      dispatch("input", { runtimeSetupField: "embedding-key" }, value),
    changeEmbeddingProvider: (value: string) =>
      dispatch("change", { runtimeSetupField: "embedding-provider" }, value),
    skipToReview: async () => {
      await ready();
      dispatch("click", { runtimeSetupAction: "skip-embedding" });
      await ready();
      listeners.get("submit")?.({ preventDefault: vi.fn() });
    },
    click: (value: string) => dispatch("click", { runtimeSetupAction: value }),
    submit: () => listeners.get("submit")?.({ preventDefault: vi.fn() }),
  };
}
