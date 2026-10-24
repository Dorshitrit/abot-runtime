import { vi } from "vitest";
// @ts-expect-error Browser JavaScript module.
import { createLongTermMemorySetup } from "../../../web-ui/app/components/long-term-memory-setup.js";
import { FakeElement } from "./model-setup-wizard-harness.js";

export const embeddingProfiles = [
  { id: "cloud-small", label: "OpenAI small", providerId: "cloud", model: "text-embedding-3-small" },
  { id: "ollama-qwen", label: "Qwen local", providerId: "ollama", model: "qwen3-embedding:0.6b" },
  { id: "cpp-qwen", label: "Qwen server", providerId: "cpp", model: "qwen3-embedding:0.6b" },
];
export const embeddingStatus = {
  enabled: true, profileId: "cloud-small", providerId: "cloud", model: "text-embedding-3-small",
  providers: [{ id: "cloud", type: "openai" }, { id: "ollama", type: "ollama" }, { id: "cpp", type: "llamacpp" }],
  embeddingProfiles,
};

class EmbeddingSetupRoot extends FakeElement {
  override get innerHTML() { return super.innerHTML; }
  override set innerHTML(value: string) {
    super.innerHTML = value;
    for (const select of this.querySelectorAll("select")) {
      const option = select.querySelector("option[selected]") ?? select.querySelector("option");
      select.value = option?.value ?? "";
    }
  }
}

/** Browser event currentTarget changes at each listener; disabled controls do not dispatch. */
function dispatchEmbeddingEvent(target: FakeElement, name: string) {
  if (target.isBlocked()) return;
  const event = { target, currentTarget: target, preventDefault: vi.fn() };
  let current: FakeElement | null = target;
  while (current) {
    event.currentTarget = current;
    for (const listener of current.listeners.get(name) || []) listener(event);
    current = current.parentElement;
  }
}

type SavedProfileInput = { providerId: string; model: string; label: string };
type EnableInput = { providerId: string; model: string; profileId: string; emitClientEvents: boolean };

export async function createEmbeddingSetupHarness(overrides: Record<string, unknown> = {}) {
  const root = new EmbeddingSetupRoot("section", {} as ConstructorParameters<typeof FakeElement>[1]);
  let environment = "dev";
  let currentStatus = structuredClone(embeddingStatus);
  const enableMemory = vi.fn(async (input: EnableInput, _environment: string) => {
    currentStatus = { ...currentStatus, ...input, enabled: true };
    return { status: currentStatus };
  });
  const saveProfile = vi.fn(async (input: SavedProfileInput, _environment: string) => {
    const profile = { ...input, id: "saved-choice" };
    currentStatus = { ...currentStatus, embeddingProfiles: [...currentStatus.embeddingProfiles, profile] };
    return { status: currentStatus, profileId: profile.id };
  });
  const removeProfile = vi.fn(async (input: { profileId: string }, _environment: string) => {
    currentStatus = {
      ...currentStatus,
      embeddingProfiles: currentStatus.embeddingProfiles.filter((profile) => profile.id !== input.profileId),
    };
    return { status: currentStatus };
  });
  const loadStatus = vi.fn(async () => ({ status: structuredClone(currentStatus) }));
  const discoverModels = vi.fn();
  const refreshRuntimeConfig = vi.fn(async () => true);
  const endRuntimeMutation = vi.fn();
  const recordControlEvent = vi.fn();
  const setup = createLongTermMemorySetup({
    getEnvironmentId: () => environment, loadStatus, discoverModels,
    enableMemory, saveProfile, removeProfile, disableMemory: vi.fn(),
    recordControlEvent, refreshRuntimeConfig, endRuntimeMutation, ...overrides,
  });
  setup.mount(root);
  await setup.load();
  const element = (selector: string) => {
    const found = root.querySelector(selector);
    if (!found) throw new Error("Missing embedding setup control: " + selector);
    return found;
  };
  const field = (name: string) => element(`[data-memory-${name}]`);
  const input = (name: string, value: string) => {
    const target = field(name);
    if (target.isBlocked()) throw new Error("Cannot edit disabled embedding control: " + name);
    target.value = value;
    dispatchEmbeddingEvent(target, "input");
  };
  const clickSelector = (selector: string) => dispatchEmbeddingEvent(element(selector), "click");
  const click = (action: string) => clickSelector(`[data-memory-action="${action}"]`);
  const choose = (id: string) => clickSelector(`[data-memory-saved-profile="${id}"]`);
  const newProfile = () => clickSelector("[data-memory-new-profile]");
  const fillDraft = (label = "My Qwen", provider = "cpp", model = "qwen3-embedding:0.6b") => {
    newProfile();
    input("profile-label", label);
    input("provider", provider);
    input("model", model);
  };
  return {
    root, setup, element, field, input, clickSelector, click, choose, newProfile, fillDraft,
    enableMemory, saveProfile, removeProfile, loadStatus, discoverModels,
    refreshRuntimeConfig, endRuntimeMutation, recordControlEvent,
    environment: (id: string) => { environment = id; },
  };
}
