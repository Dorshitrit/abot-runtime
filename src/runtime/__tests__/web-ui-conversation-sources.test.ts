import { describe, expect, test } from "vitest";
import { createConversationActivity } from "../../web-ui/app/components/conversation-activity.js";
import { createConversationSources } from "../../web-ui/app/components/conversation-sources.js";
import type {
  ConversationSourcesGroup,
  WebSource,
} from "../../web-ui/app/lib/web-sources.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

type SourceElement = ContextElement & {
  href: string;
  target: string;
  rel: string;
  title: string;
  src: string;
  loading: string;
  referrerPolicy: string;
  width: number;
  height: number;
};

function createSourceDom() {
  const documentRoot = {
    createElement: (tag: string) =>
      Object.assign(new ContextElement(tag), {
        open: false,
        scrollTop: 0,
        scrollHeight: 500,
      }),
    defaultView: { requestAnimationFrame: () => 0 },
  } as unknown as Document;
  return { documentRoot };
}

function child(root: HTMLElement, selector: string) {
  const found = root.querySelector(selector);
  expect(found).not.toBeNull();
  return found as unknown as SourceElement;
}

const source: WebSource = {
  url: "https://example.com/article?lang=he#news",
  title: "An article",
  retrieval: "retrieved",
  presentation: "content",
  contentTruncated: false,
};

function group(sources: WebSource[] = [source]): ConversationSourcesGroup {
  return {
    id: "call-a",
    callId: "call-a",
    version: 1,
    operation: "search",
    provider: "light",
    sources,
  };
}

describe("conversation source cards", () => {
  test("renders a keyboard link with the exact source URL and an origin-only lazy icon", () => {
    const { documentRoot } = createSourceDom();
    const node = createConversationSources({ documentRoot }).createNode([
      group(),
    ])!;
    const link = child(node, ".conversation-source-link");
    expect(link.tagName).toBe("a");
    expect(link.href).toBe(source.url);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(child(node, ".conversation-source-domain").textContent).toBe(
      "example.com",
    );
    expect(node.querySelector(".conversation-source-url")).toBeNull();
    expect(node.querySelector(".conversation-source-title")).toBeNull();
    expect(link.title).toContain(source.url);
    expect(link.title).toContain(source.title);
    expect(link.getAttribute("aria-label")).toBe(link.title);
    expect(link.children).toHaveLength(3);
    expect(node.getAttribute("aria-label")).toBe("Web sources");
    const icon = child(node, "img");
    expect(icon.src).toBe("https://example.com/favicon.ico");
    expect(icon.loading).toBe("lazy");
    expect(icon.referrerPolicy).toBe("no-referrer");
    expect(icon.width).toBe(16);
    expect(icon.height).toBe(16);
    expect(
      child(node, ".conversation-source-icon").getAttribute("aria-hidden"),
    ).toBe("true");
    expect(child(node, ".conversation-sources-provider").textContent).toBe(
      "Light",
    );
  });

  test("keeps full titles inert in tooltips and accessible labels without duplicate visible lines", () => {
    const { documentRoot } = createSourceDom();
    const maliciousTitle = "כותרת <script>alert(1)</script>";
    const node = createConversationSources({ documentRoot }).createNode([
      group([{ ...source, title: maliciousTitle }]),
    ])!;
    expect(node.querySelector("script")).toBeNull();
    const link = child(node, ".conversation-source-link");
    expect(link.title).toContain(maliciousTitle);
    expect(link.getAttribute("aria-label")).toContain(maliciousTitle);
    expect(link.textContent).not.toContain(maliciousTitle);
    expect(link.textContent.match(/example\.com/g)).toHaveLength(1);
  });

  test.each([
    ["content", "Content", "Content returned"],
    ["snippet", "Snippet", "Snippet returned"],
    ["reference", "Link", "Reference returned"],
    ["omitted", "Omitted", "Omitted from tool output"],
  ] as const)(
    "distinguishes %s from other output representations",
    (presentation, label, detail) => {
      const { documentRoot } = createSourceDom();
      const node = createConversationSources({ documentRoot }).createNode([
        group([{ ...source, presentation }]),
      ])!;
      expect(child(node, ".conversation-source-status").textContent).toBe(
        label,
      );
      expect(child(node, ".conversation-source-link").title).toContain(detail);
      expect(node.textContent).not.toContain("model saw");
    },
  );

  test("shows a failed fetch alongside a returned search snippet", () => {
    const { documentRoot } = createSourceDom();
    const node = createConversationSources({ documentRoot }).createNode([
      group([
        {
          ...source,
          retrieval: "failed",
          presentation: "snippet",
          contentTruncated: true,
        },
      ]),
    ])!;
    expect(child(node, ".conversation-source-status").textContent).toBe(
      "Snippet · failed",
    );
    expect(
      child(node, ".conversation-source-status").classList.contains(
        "is-failed",
      ),
    ).toBe(true);
    const link = child(node, ".conversation-source-link");
    expect(link.title).toContain("Snippet returned");
    expect(link.title).toContain("Fetch failed");
    expect(link.title).toContain("Partial content");
    expect(link.getAttribute("aria-label")).toBe(link.title);
  });

  test.each([
    ["retrieved", "Fetched"],
    ["not_attempted", "Found"],
  ] as const)(
    "labels legacy %s results without stronger output claims",
    (retrieval, label) => {
      const { documentRoot } = createSourceDom();
      const legacy = {
        ...group([{ ...source, presentation: "unknown", retrieval }]),
        version: 0 as const,
        provider: undefined,
      };
      const node = createConversationSources({ documentRoot }).createNode([
        legacy,
      ])!;
      expect(child(node, ".conversation-source-status").textContent).toBe(
        label,
      );
      expect(node.querySelector(".conversation-sources-provider")).toBeNull();
      expect(node.textContent).not.toContain("Content returned");
    },
  );

  test("keeps a readable local initial after image failure and for private IP sources", () => {
    const { documentRoot } = createSourceDom();
    const renderer = createConversationSources({ documentRoot });
    const node = renderer.createNode([group()])!;
    const icon = child(node, "img");
    const fallback = child(node, ".conversation-source-initial");
    icon.dispatch("load");
    expect(fallback.hidden).toBe(true);
    icon.dispatch("error");
    expect(icon.hidden).toBe(true);
    expect(fallback.hidden).toBe(false);
    expect(fallback.textContent).toBe("E");
    const local = renderer.createNode([
      group([{ ...source, url: "http://127.0.0.1/page" }]),
    ])!;
    expect(local.querySelector("img")).toBeNull();
    expect(child(local, ".conversation-source-link").href).toBe(
      "http://127.0.0.1/page",
    );
  });

  test("preserves redirect provenance in link details without adding a visible line", () => {
    const { documentRoot } = createSourceDom();
    const node = createConversationSources({ documentRoot }).createNode([
      group([{ ...source, requestedUrl: "https://example.com/old" }]),
    ])!;
    expect(child(node, ".conversation-source-link").href).toBe(source.url);
    expect(child(node, ".conversation-source-link").title).toContain(
      "Requested: https://example.com/old",
    );
    expect(node.querySelector(".conversation-source-requested")).toBeNull();
  });

  test("does not turn invalid input into links even if normalization was bypassed", () => {
    const { documentRoot } = createSourceDom();
    const renderer = createConversationSources({ documentRoot });
    const node = renderer.createNode([
      group([{ ...source, url: "javascript:alert(1)" }]),
    ])!;
    expect(node.querySelector("a")).toBeNull();
    expect(node.querySelector("img")).toBeNull();
    expect(renderer.createNode([])).toBeNull();
  });

  test("discloses metadata omissions without inventing clickable sources or changing output status", () => {
    const { documentRoot } = createSourceDom();
    const renderer = createConversationSources({ documentRoot });
    const node = renderer.createNode([{ ...group(), omittedSourceCount: 2 }])!;
    expect(child(node, ".conversation-source-link").href).toBe(source.url);
    const notice = child(node, ".conversation-sources-omitted");
    expect(notice.textContent).toContain("2 additional sources");
    expect(notice.title).toContain("Tool output was preserved");
    expect(notice.getAttribute("aria-label")).toContain("metadata exceeded");
    const onlyOmitted = renderer.createNode([
      { ...group([]), omittedSourceCount: 25 },
    ])!;
    expect(onlyOmitted.querySelector("a")).toBeNull();
    expect(
      child(onlyOmitted, ".conversation-sources-omitted").textContent,
    ).toContain("25 additional sources");
  });
});

describe("sources composed with activity role cards", () => {
  test("keeps sources in Activity across role/timeline toggles with summary avatars intact", () => {
    const { documentRoot } = createSourceDom();
    const activity = createConversationActivity({ documentRoot });
    const input = {
      requestId: "request-a",
      streaming: true,
      events: [
        {
          requestId: "request-a",
          name: "agent.status",
          stage: "worker",
          phase: "working",
          message: "Searching",
        },
        { requestId: "request-a", name: "tool.started", tool: "web_search" },
        {
          requestId: "request-a",
          name: "tool.completed",
          tool: "web_search",
          callId: "call-a",
          webSources: group(),
        },
      ],
    };
    const node = activity.createNode(input)!;
    const body = child(node, ".conversation-activity-body");
    const sources = child(node, ".conversation-sources");
    expect(sources.parentElement).toBe(body);
    expect(
      node.querySelector(".conversation-role-summary-strip"),
    ).not.toBeNull();
    expect(child(node, ".conversation-activity-facts").textContent).toBe(
      "1 tool · 1 source",
    );
    const toggle = child(node, ".conversation-role-toggle");
    toggle.dispatch("click");
    expect(sources.hidden).toBe(false);
    expect(child(node, ".conversation-role-list").hidden).toBe(true);
    expect(child(node, ".conversation-activity-timeline").hidden).toBe(false);
    const rerender = activity.createNode(input)!;
    expect(child(rerender, ".conversation-role-list").hidden).toBe(true);
    expect(rerender.querySelector(".conversation-sources")).not.toBeNull();
    activity.reset();
    expect(
      activity.createNode({ requestId: "request-b", events: [] }),
    ).toBeNull();
  });

  test("leaves historical non-web Activity without a source section", () => {
    const { documentRoot } = createSourceDom();
    const node = createConversationActivity({ documentRoot }).createNode({
      requestId: "old-request",
      events: [
        { requestId: "old-request", name: "tool.completed", tool: "read_file" },
      ],
    })!;
    expect(node.querySelector(".conversation-sources")).toBeNull();
    expect(
      node.querySelector(".conversation-activity-timeline"),
    ).not.toBeNull();
    expect(child(node, ".conversation-activity-facts").textContent).toBe(
      "1 events",
    );
  });

  test("includes known omitted sources in the Activity summary with an explicit detail notice", () => {
    const { documentRoot } = createSourceDom();
    const node = createConversationActivity({ documentRoot }).createNode({
      requestId: "request-a",
      events: [
        {
          requestId: "request-a",
          name: "tool.completed",
          tool: "web_search",
          webSources: { ...group([]), omittedSourceCount: 25 },
        },
      ],
    })!;
    expect(child(node, ".conversation-activity-facts").textContent).toBe(
      "25 sources",
    );
    expect(child(node, ".conversation-sources-omitted").textContent).toContain(
      "25 additional sources",
    );
    expect(node.querySelector(".conversation-source-link")).toBeNull();
  });
});
