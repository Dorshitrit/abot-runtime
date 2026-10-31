import { vi } from "vitest";
import { createRuntimeSetupGuide } from "../../../web-ui/app/components/runtime-setup-guide.js";
import type { ChatgptAccountRequests } from "../../../web-ui/app/services/runtime-web-client/chatgpt-accounts.js";
import { createModelWizardHarness } from "./model-setup-wizard-harness.js";

/** Exercise the shared account flow through each actual form owner. */
export async function openChatgptSetupFlow(
  flow: "first-run" | "add-model",
  client: ChatgptAccountRequests,
) {
  const harness = createModelWizardHarness({ chatgptClient: client });
  if (flow === "add-model") {
    await harness.wizard.open();
    harness.choose("new:openai-chatgpt");
    harness.click("next");
    return {
      container: harness.dialog,
      document: harness.document,
      refresh: () => harness.input("context-window", "32000"),
      close: () => harness.wizard.close(),
    };
  }
  const container = harness.document.createElement("section");
  const region = harness.document.createElement("section");
  harness.document.body.append(container);
  harness.document.body.append(region);
  const snapshot = {
    status: "required" as const,
    configExists: false,
    defaultContextWindowTokens: 32768,
    providers: [{
      id: "openai-chatgpt" as const,
      label: "ChatGPT",
      requiresApiKey: false,
      credentialConfigured: false,
    }],
  };
  const guide = createRuntimeSetupGuide({
    container: container as unknown as HTMLElement,
    conversationRegion: region as unknown as HTMLElement,
    chatgptClient: client,
    loadSetup: async () => ({ setup: snapshot }),
    saveSetup: async () => ({ setup: snapshot, activation: { status: "restart_required" } }),
    applySetup: async () => ({ activation: { status: "ready" } }),
    loadEmbeddingStatus: async () => ({}),
    discoverEmbeddingModels: async () => ({}),
    saveEmbedding: async () => ({}),
    loadPlugins: async () => ({}),
    setPlugin: async () => ({}),
  });
  guide.bind();
  guide.render({ status: "setup_required" });
  await vi.waitFor(() => expectProvider());
  container.querySelector('[data-runtime-setup-field="provider"]')!.dispatch("change");
  container.querySelector("form")!.dispatch("submit");
  function expectProvider() {
    if (!container.querySelector('[data-runtime-setup-field="provider"]'))
      throw new Error("Provider choices not ready");
  }
  return {
    container,
    document: harness.document,
    refresh: () => guide.render({ status: "setup_required" }),
    close: () => guide.dispose(),
  };
}
