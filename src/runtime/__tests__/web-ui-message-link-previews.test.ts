import { describe, expect, test, vi } from "vitest";

import { createMessageLinkPreviews } from "../../web-ui/app/components/message-link-previews.js";
import {
  createMessageLinkPreviewClient,
  type MessageLinkPreview,
} from "../../web-ui/app/services/message-link-preview-client.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

const baseURI = "http://localhost:8787/";
const source = "https://example.com/article";
const preview: MessageLinkPreview = {
  url: "https://redirect.example/elsewhere",
  title: "An article title",
  description: "The article description",
  imageUrl: "/web-link-preview/image?id=11111111-2222-3333-4444-555555555555",
  siteName: "Example",
};

type PreviewElement = ContextElement & {
  href?: string;
  src?: string;
  target?: string;
  rel?: string;
  title?: string;
};

function child(node: HTMLElement, selector: string) {
  const found = node.querySelector(selector);
  expect(found).not.toBeNull();
  return found as unknown as PreviewElement;
}

function createPreviewDom() {
  const documentRoot = {
    baseURI,
    createElement: (tagName: string) => new ContextElement(tagName),
  } as unknown as Document;
  const viewport = {} as Window;
  const scrollRoot = new ContextElement("main") as unknown as Element;
  return { documentRoot, viewport, scrollRoot };
}

function settledClient(result: MessageLinkPreview | null = preview) {
  return { get: vi.fn(async () => result), cancelQueued: vi.fn() };
}

describe("web ui message link previews", () => {
  test.each(["user", "assistant"])(
    "renders and hydrates %s links without changing destinations",
    async (role) => {
      const client = settledClient();
      const onLayoutChange = vi.fn();
      const component = createMessageLinkPreviews({
        ...createPreviewDom(),
        client,
        onLayoutChange,
      });
      const node = component.createNode({
        role,
        text: `[Read this](${source})`,
      })!;
      const anchor = child(node, ".message-link-preview");
      expect(anchor.href).toBe(source);
      expect(anchor.target).toBe("_blank");
      expect(anchor.rel).toBe("noopener noreferrer");
      expect(child(node, ".message-link-preview-title").textContent).toBe(
        "Read this",
      );
      await Promise.resolve();
      expect(child(node, ".message-link-preview-title").textContent).toBe(
        preview.title,
      );
      expect(anchor.title).toBe(
        `${preview.title}\n${preview.description}\n${source}`,
      );
      expect(anchor.getAttribute("aria-label")).toBe(anchor.title);
      expect(anchor.textContent).not.toContain(preview.description);
      expect(anchor.textContent).not.toContain(source);
      expect(child(node, ".message-link-preview-image").src).toBe(
        new URL(preview.imageUrl, baseURI).href,
      );
      expect(anchor.href).toBe(source);
      expect(onLayoutChange).toHaveBeenCalledOnce();
      const image = child(node, ".message-link-preview-image");
      image.dispatch("error");
      expect(image.hidden).toBe(true);
      expect(anchor.href).toBe(source);
    },
  );

  test("defers streaming URLs and leaves ordinary text without a preview container", () => {
    const client = settledClient();
    const component = createMessageLinkPreviews({
      ...createPreviewDom(),
      client,
    });
    expect(component.createNode({ text: source, streaming: true })).toBeNull();
    expect(component.createNode({ text: "No link here" })).toBeNull();
    expect(component.createNode({ text: `\`${source}\`` })).toBeNull();
    expect(client.get).not.toHaveBeenCalled();
  });

  test("preserves a clickable fallback when metadata is unavailable", async () => {
    const client = settledClient(null);
    const component = createMessageLinkPreviews({
      ...createPreviewDom(),
      client,
    });
    const node = component.createNode({ text: source })!;
    await Promise.resolve();
    expect(child(node, ".message-link-preview").href).toBe(source);
    expect(child(node, ".message-link-preview-domain").textContent).toBe(
      "example.com",
    );
    expect(child(node, ".message-link-preview").title).toContain(source);
    expect(child(node, ".message-link-preview-image").hidden).toBe(true);
  });

  test.each([
    "https://tracker.example/image.jpg",
    "/web-link-preview/image?id=bad-token",
    "/other-image?id=11111111-2222-3333-4444-555555555555",
    "javascript:alert(1)",
  ])(
    "rejects an unapproved image URL %s and treats metadata as plain text",
    async (imageUrl) => {
      const title = "<img src=x onerror=alert(1)>";
      const client = settledClient({
        ...preview,
        title,
        description: "<script>bad()</script>",
        imageUrl,
      });
      const component = createMessageLinkPreviews({
        ...createPreviewDom(),
        client,
      });
      const node = component.createNode({ text: source })!;
      await Promise.resolve();
      expect(child(node, ".message-link-preview-title").textContent).toBe(
        title,
      );
      expect(child(node, ".message-link-preview-title").children).toHaveLength(
        0,
      );
      expect(child(node, ".message-link-preview-image").src).toBeUndefined();
      expect(child(node, ".message-link-preview-image").hidden).toBe(true);
    },
  );

  test("loads only intersecting cards and disconnects obsolete observers", async () => {
    const dom = createPreviewDom();
    const observers: Array<{
      callback: IntersectionObserverCallback;
      observe: ReturnType<typeof vi.fn>;
      unobserve: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    class FakeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(readonly callback: IntersectionObserverCallback) {
        observers.push(this);
      }
    }
    const client = settledClient();
    const component = createMessageLinkPreviews({
      ...dom,
      viewport: { IntersectionObserver: FakeObserver } as unknown as Window & {
        IntersectionObserver: typeof IntersectionObserver;
      },
      client,
    });
    const node = component.createNode({ text: source })!;
    const target = child(node, ".message-link-preview") as unknown as Element;
    const observer = observers[0];
    expect(client.get).not.toHaveBeenCalled();
    observer.callback(
      [{ target, isIntersecting: false }] as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
    expect(client.get).not.toHaveBeenCalled();
    observer.callback(
      [{ target, isIntersecting: true }] as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
    expect(client.get).toHaveBeenCalledWith(source);
    expect(observer.unobserve).toHaveBeenCalledWith(target);
    await Promise.resolve();
    component.reset();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    observer.callback(
      [{ target, isIntersecting: true }] as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
    expect(client.get).toHaveBeenCalledOnce();
  });

  test("reuses pending metadata across rerenders without mutating obsolete cards", async () => {
    let resolve!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );
    const client = createMessageLinkPreviewClient({ fetchImpl });
    const onLayoutChange = vi.fn();
    const component = createMessageLinkPreviews({
      ...createPreviewDom(),
      client,
      onLayoutChange,
    });
    const oldNode = component.createNode({ text: source })!;
    component.reset();
    const currentNode = component.createNode({ text: source })!;
    const loaded = client.get(source);
    resolve({
      ok: true,
      json: async () => ({ ok: true, preview }),
    } as Response);
    await loaded;
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(child(oldNode, ".message-link-preview-title").textContent).toBe(
      "example.com",
    );
    expect(child(currentNode, ".message-link-preview-title").textContent).toBe(
      preview.title,
    );
    expect(onLayoutChange).toHaveBeenCalledOnce();
    component.reset();
    const cachedNode = component.createNode({ text: source })!;
    await Promise.resolve();
    expect(child(cachedNode, ".message-link-preview-title").textContent).toBe(
      preview.title,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
