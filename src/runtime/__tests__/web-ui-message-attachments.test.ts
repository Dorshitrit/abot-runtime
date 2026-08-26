import { describe, expect, test, vi } from "vitest";

import {
  buildMessageAttachmentsModel,
  createMessageAttachments,
} from "../../web-ui/app/components/message-attachments.js";

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}

  add(...tokens: string[]): void {
    const classes = new Set(this.owner.className.split(/\s+/u).filter(Boolean));
    for (const token of tokens) classes.add(token);
    this.owner.className = [...classes].join(" ");
  }

  contains(token: string): boolean {
    return this.owner.className.split(/\s+/u).includes(token);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<() => void>>();
  readonly classList = new FakeClassList(this);
  className = "";
  textContent = "";
  hidden = false;
  src = "";
  alt = "";
  loading = "";
  decoding = "";

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  addEventListener(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

function createFakeDocument(): Document {
  return {
    baseURI: "http://127.0.0.1:5177/chat",
    createElement: (tagName: string) =>
      new FakeElement(tagName.toUpperCase()) as unknown as HTMLElement,
  } as unknown as Document;
}

describe("web ui message attachments", () => {
  test("builds same-origin image previews while documents remain labels", () => {
    const resolveAttachmentUrl = vi.fn(
      () => "/web-api/chat/attachments?sessionId=session-1",
    );

    const model = buildMessageAttachmentsModel({
      attachments: [
        {
          id: "att-image",
          kind: "image",
          mimeType: "image/png",
          name: "screen.png",
        },
        {
          id: "att-document",
          kind: "file",
          mimeType: "application/pdf",
          name: "brief.pdf",
        },
      ],
      resolveAttachmentUrl,
      baseHref: "http://127.0.0.1:5177/chat",
    });

    expect(model).toEqual([
      {
        name: "screen.png",
        kind: "image",
        imageUrl:
          "http://127.0.0.1:5177/web-api/chat/attachments?sessionId=session-1",
      },
      { name: "brief.pdf", kind: "file", imageUrl: "" },
    ]);
    expect(resolveAttachmentUrl).toHaveBeenCalledTimes(1);
  });

  test("falls back to a filename for unsafe or failed image URL resolution", () => {
    expect(
      buildMessageAttachmentsModel({
        attachments: [
          {
            id: "att-image",
            kind: "image",
            mimeType: "image/jpeg",
            name: "photo.jpg",
          },
        ],
        resolveAttachmentUrl: () => "javascript:alert(1)",
        baseHref: "http://127.0.0.1:5177/chat",
      }),
    ).toEqual([{ name: "photo.jpg", kind: "file", imageUrl: "" }]);

    expect(
      buildMessageAttachmentsModel({
        attachments: [
          {
            id: "att-image",
            kind: "image",
            mimeType: "image/webp",
            name: "photo.webp",
          },
        ],
        resolveAttachmentUrl: () => {
          throw new Error("missing attachment URL");
        },
        baseHref: "http://127.0.0.1:5177/chat",
      }),
    ).toEqual([{ name: "photo.webp", kind: "file", imageUrl: "" }]);
  });

  test("renders safe image properties and preserves a text-only fallback", () => {
    const component = createMessageAttachments({
      documentRoot: createFakeDocument(),
      resolveAttachmentUrl: () =>
        "/web-api/chat/attachments?sessionId=session-1&mimeType=image%2Fpng",
    });

    const container = component.createNode([
      {
        id: "att-image",
        kind: "image",
        mimeType: "image/png",
        name: '<img src=x onerror="alert(1)">.png',
      },
      {
        id: "att-document",
        kind: "file",
        mimeType: "application/pdf",
        name: "brief.pdf",
      },
    ]) as unknown as FakeElement;

    expect(container.className).toBe("message-attachments");
    expect(container.attributes.get("aria-label")).toBe("Attachments");
    expect(container.children).toHaveLength(2);

    const imageAttachment = container.children[0]!;
    const image = imageAttachment.children[0]!;
    const caption = imageAttachment.children[1]!;
    expect(imageAttachment.tagName).toBe("FIGURE");
    expect(image.tagName).toBe("IMG");
    expect(image.src).toBe(
      "http://127.0.0.1:5177/web-api/chat/attachments?sessionId=session-1&mimeType=image%2Fpng",
    );
    expect(image.alt).toBe('<img src=x onerror="alert(1)">.png');
    expect(image.loading).toBe("lazy");
    expect(image.decoding).toBe("async");
    expect(caption.textContent).toBe('<img src=x onerror="alert(1)">.png');

    const documentAttachment = container.children[1]!;
    expect(documentAttachment.tagName).toBe("SPAN");
    expect(documentAttachment.children).toHaveLength(1);
    expect(documentAttachment.children[0]?.textContent).toBe("brief.pdf");

    image.dispatch("error");
    expect(image.hidden).toBe(true);
    expect(imageAttachment.classList.contains("load-failed")).toBe(true);
    expect(caption.textContent).toBe('<img src=x onerror="alert(1)">.png');
  });
});
