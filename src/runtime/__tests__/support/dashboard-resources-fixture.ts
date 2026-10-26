import { vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardResourcesController } from "../../../web-ui/app/controllers/dashboard-resources-controller.js";
import type { BasketSource, BasketView } from "../../information-basket/contracts.js";

export const attentionSource: BasketSource = {
  sourceId: "source-a", displayName: "Project notes.md", path: "/documents/Project notes.md",
  revision: 3, status: "stale", sizeBytes: 100, chunkCount: 2,
  indexedAt: "2026-10-25T10:00:00Z", reason: "basket_source_changed",
};
export function basketView(sources: readonly BasketSource[] = [attentionSource]): BasketView {
  return {
    settings: { revision: 2, enabled: true, embeddingProfileId: "local-embed" }, sources,
    embeddingProfiles: [{ id: "local-embed", label: "Local", provider: "ollama", model: "embedding" }],
    supportedExtensions: [".md"],
    limits: { maxSources: 100, maxSourceBytes: 10000, maxReadCharacters: 1000 },
  };
}
export const replacementPath = "/documents/Relinked notes.md";
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { resolve, reject, promise };
}
export function resourcesFixture(options: {
  view?: BasketView; interactive?: boolean; supported?: boolean;
} = {}) {
  let environmentId = "dev";
  let interactive = options.interactive ?? true;
  let supported = options.supported ?? true;
  const initial = options.view ?? basketView();
  const queued = basketView([{ ...attentionSource, status: "queued", reason: null, revision: 4 }]);
  const client = {
    supportsInformationBasket: vi.fn(() => supported),
    listInformationBasket: vi.fn(async (): Promise<BasketView> => initial),
    reindexInformationBasketSource: vi.fn(async (): Promise<BasketView> => queued),
    relinkInformationBasketSource: vi.fn(async (): Promise<BasketView> => queued),
    browseInformationBasket: vi.fn(async () => ({
      directory: "/documents", parent: "/",
      roots: [{ label: "Documents", path: "/documents" }],
      entries: [{ name: "Relinked notes.md", path: replacementPath, kind: "file", supported: true }],
      nextCursor: null, hostPlatform: "linux",
    })),
  };
  const render = vi.fn();
  const notify = vi.fn();
  const controller = createDashboardResourcesController({
    client, getEnvironmentId: () => environmentId, render, notify, isInteractive: () => interactive,
  });
  return {
    client, controller, render, notify, attention: () => controller.snapshot().resourceAttention,
    getEnvironmentId: () => environmentId,
    setEnvironment(value: string) { environmentId = value; },
    setInteractive(value: boolean) { interactive = value; },
    setSupported(value: boolean) { supported = value; },
  };
}
