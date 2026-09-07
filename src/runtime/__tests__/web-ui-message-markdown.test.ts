import { Parser } from "htmlparser2";
import { describe, expect, test } from "vitest";
import {
  extractMessageLinks,
  renderMarkdown,
} from "../../web-ui/app/lib/message-markdown.js";
import { safeLinkHref } from "../../web-ui/app/lib/message-url-policy.js";

function inspectMarkup(source: string) {
  const tags: Array<{ name: string; attributes: Record<string, string> }> = [];
  let text = "";
  new Parser({
    onopentag(name, attributes) {
      tags.push({ name, attributes });
    },
    ontext(value) {
      text += value;
    },
  }).end(renderMarkdown(source));
  return {
    tags,
    text,
    links: tags.filter((tag) => tag.name === "a").map((tag) => tag.attributes),
  };
}

describe("message Markdown", () => {
  test("makes bare and labelled URLs clickable without corrupting query strings", () => {
    const url = "https://example.com/search?q=hello&lang=he#results";
    const result = inspectMarkup(`ראו ${url}.\n[**המקור**](${url})`);
    expect(result.links).toEqual([
      { href: url, target: "_blank", rel: "noopener noreferrer" },
      { href: url, target: "_blank", rel: "noopener noreferrer" },
    ]);
    expect(result.text).toContain("המקור");
    expect(result.text).toContain(`${url}.`);
  });

  test("handles www addresses, angle autolinks and reference links", () => {
    const result = inspectMarkup(
      "www.example.com\n<https://example.org>\n[Reference][ref]\n\n[ref]: https://example.net/a_(b)",
    );
    expect(result.links.map((link) => link.href)).toEqual([
      "http://www.example.com",
      "https://example.org",
      "https://example.net/a_(b)",
    ]);
  });

  test("renders emphasis, all heading levels, nested lists, quotes and tables", () => {
    const result = inspectMarkup(
      [
        "# Heading",
        "",
        "###### Small heading",
        "",
        "**bold** __also bold__ *italic* _also italic_ ~~removed~~",
        "",
        "3. first",
        "4. second",
        "   - nested",
        "",
        "> quoted",
        "",
        "| Name | Amount |",
        "| :--- | ---: |",
        "| **one** | 2 |",
      ].join("\n"),
    );
    const names = result.tags.map((tag) => tag.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "h1",
        "h6",
        "strong",
        "em",
        "s",
        "ol",
        "ul",
        "blockquote",
        "table",
        "thead",
        "th",
        "tbody",
        "td",
      ]),
    );
    expect(result.tags.find((tag) => tag.name === "ol")?.attributes.start).toBe(
      "3",
    );
    expect(
      result.tags.find((tag) => tag.name === "div")?.attributes,
    ).toMatchObject({
      class: "markdown-table-scroll",
      role: "region",
      tabindex: "0",
    });
    expect(result.tags.filter((tag) => tag.name === "th")).toHaveLength(2);
    expect(result.tags.find((tag) => tag.name === "th")?.attributes.style).toBe(
      "text-align:left",
    );
  });

  test("keeps inline/fenced code literal and out of previews", () => {
    const source =
      "`https://example.com **literal**`\n\n```html\n<script>alert(1)</script>\nhttps://example.org\n```";
    const result = inspectMarkup(source);
    expect(result.links).toEqual([]);
    expect(result.text).toContain("<script>alert(1)</script>");
    expect(result.tags.filter((tag) => tag.name === "code")).toHaveLength(2);
    expect(extractMessageLinks(source)).toEqual([]);
  });

  test.each([
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    '<svg><a xlink:href="javascript:alert(1)">bad</a></svg>',
    "[bad](javascript:alert(1))",
    "[bad](jav&#x61;script:alert(1))",
    "[bad](data:text/html,test)",
    "[bad](file:///etc/passwd)",
    "[bad](https://user:secret@example.com)",
  ])("never emits active content for %s", (source) => {
    const result = inspectMarkup(source);
    expect(result.links).toEqual([]);
    expect(
      result.tags.some((tag) =>
        ["script", "img", "svg", "iframe"].includes(tag.name),
      ),
    ).toBe(false);
    expect(extractMessageLinks(source)).toEqual([]);
  });

  test("renders image resources as links for the protected preview path", () => {
    const source = '![Photo](https://example.com/photo.png "Title")';
    const result = inspectMarkup(source);
    expect(result.links[0]?.href).toBe("https://example.com/photo.png");
    expect(result.tags.some((tag) => tag.name === "img")).toBe(false);
    expect(extractMessageLinks(source)).toEqual([
      { url: "https://example.com/photo.png", label: "Photo" },
    ]);
  });

  test("deduplicates previews, including anchors, and bounds cards without dropping text links", () => {
    const source =
      "[One](https://one.example/a#first)\nhttps://one.example/a#second\nhttps://two.example\nhttps://three.example\nhttps://four.example";
    expect(extractMessageLinks(source)).toEqual([
      { url: "https://one.example/a#first", label: "One" },
      { url: "https://two.example/", label: "https://two.example" },
      { url: "https://three.example/", label: "https://three.example" },
    ]);
    expect(inspectMarkup(source).links).toHaveLength(5);
  });

  test("preserves the destination of a linked image without nesting anchors", () => {
    const source =
      "[![Badge](https://img.example/badge.png)](https://docs.example/guide)";
    const result = inspectMarkup(source);
    expect(result.links.map((link) => link.href)).toEqual([
      "https://docs.example/guide",
    ]);
    expect(result.text.trim()).toBe("Badge");
    expect(extractMessageLinks(source)).toEqual([
      { url: "https://docs.example/guide", label: "Badge" },
    ]);
  });

  test("handles partial streaming syntax without making code or HTML active", () => {
    const source =
      "**Result**\n\n| A | B |\n| --- | --- |\n| x | y |\n\n```js\nhttps://example.com\n<script>";
    for (let index = 0; index <= source.length; index += 1) {
      const result = inspectMarkup(source.slice(0, index));
      expect(result.tags.some((tag) => tag.name === "script")).toBe(false);
    }
    expect(extractMessageLinks(source)).toEqual([]);
  });

  test("preserves mail links and explicitly based local links without preview fetches", () => {
    expect(safeLinkHref("mailto:test@example.com")).toBe(
      "mailto:test@example.com",
    );
    expect(safeLinkHref("/docs", "https://example.com/chat")).toBe(
      "https://example.com/docs",
    );
    expect(safeLinkHref("https://example.com/\nwrong")).toBe("");
    expect(safeLinkHref("https://user:secret@example.com")).toBe("");
    expect(extractMessageLinks("[Email](mailto:test@example.com)")).toEqual([]);
  });
});
