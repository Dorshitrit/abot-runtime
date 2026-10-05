import { Parser } from "htmlparser2";
import { describe, expect, it } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationSavedOutput } from "../../web-ui/app/components/automations/run-output-view.js";

function part(value: string, truncated = false, totalCharacters = value.length) {
  return { value, truncated, totalCharacters };
}

function inspect(markup: string) {
  const tags: Array<{ name: string; attributes: Record<string, string>; collapsed: boolean }> = [];
  const rawStack: boolean[] = [];
  let readable = "";
  let raw = "";
  new Parser({
    onopentag(name, attributes) {
      tags.push({ name, attributes, collapsed: Boolean(rawStack.at(-1)) });
      rawStack.push(Boolean(rawStack.at(-1)) || attributes.class === "automation-output-source");
    },
    onclosetag() { rawStack.pop(); },
    ontext(value) {
      if (rawStack.at(-1)) raw += value;
      else readable += value;
    },
  }).end(markup);
  return { tags, readable, raw };
}

describe("readable saved automation output", () => {
  it("presents arbitrary JSON values without assigning meaning to business fields", () => {
    const value = JSON.stringify({
      published: false, duplicate: true, article_title: "", reason: "No dated sources.",
      custom_items: [{ score: 0, approved: null }],
    });
    const view = inspect(renderAutomationSavedOutput({ data: part(value), full: false }));
    expect(view.readable).toContain("Publishedfalse");
    expect(view.readable).toContain("Duplicatetrue");
    expect(view.readable).toContain("Article titleEmpty text");
    expect(view.readable).toContain("Custom itemsScore0Approvednull");
    expect(view.readable).toContain("No dated sources.");
    expect(view.readable).not.toMatch(/Succeeded|Failed|Saved file|Published successfully/);
    expect(view.raw).toContain(value);
    expect(view.tags.filter((tag) => tag.name === "details").every((tag) => !("open" in tag.attributes))).toBe(true);
  });

  it("deduplicates the same complete JSON saved as text and data", () => {
    const data = { message: "Distinct result", items: [1, 2] };
    const view = inspect(renderAutomationSavedOutput({
      text: part(JSON.stringify(data)), data: part(JSON.stringify(data, null, 2)), full: false,
    }));
    expect(view.readable.match(/Distinct result/g)).toHaveLength(1);
    expect(view.raw.match(/Distinct result/g)).toHaveLength(1);
    expect(view.tags.filter((tag) => tag.name === "section")).toHaveLength(1);
  });

  it("keeps distinct text and data and unwraps a complete JSON string as readable prose", () => {
    const view = inspect(renderAutomationSavedOutput({
      text: part(JSON.stringify("## סיכום\n\n**נתון** חשוב")),
      data: part('{"count":3}'), full: true,
    }));
    expect(view.readable).toContain("סיכום");
    expect(view.readable).toContain("נתון חשוב");
    expect(view.readable).not.toContain("Count3");
    expect(view.raw).toContain("Additional structured data");
    expect(view.raw).toContain("Count3");
    expect(view.readable).not.toContain('"##');
    expect(view.tags.some((tag) => tag.name === "h2")).toBe(true);
    expect(view.tags.some((tag) => tag.attributes.dir === "auto")).toBe(true);
    expect(view.raw).toContain('"##');
  });

  it("uses the shared safe Markdown policy for output and nested string values", () => {
    const malicious = '<script>alert(1)</script> <img src=x onerror=alert(1)>\n' +
      '[bad](javascript:alert(1)) [data](data:text/html,x) [file](file:///private/report)\n' +
      '![remote](https://example.com/image.png) [source](https://example.com/a?q=1&b=2)';
    const view = inspect(renderAutomationSavedOutput({
      data: part(JSON.stringify({ '<img src=x onerror="bad()">': malicious })), full: false,
    }));
    expect(view.tags.some((tag) => ["script", "img", "iframe"].includes(tag.name))).toBe(false);
    expect(view.tags.some((tag) => Object.keys(tag.attributes).some((key) => key.startsWith("on")))).toBe(false);
    const links = view.tags.filter((tag) => tag.name === "a").map((tag) => tag.attributes);
    expect(links).toEqual([
      { href: "https://example.com/image.png", target: "_blank", rel: "noopener noreferrer" },
      { href: "https://example.com/a?q=1&b=2", target: "_blank", rel: "noopener noreferrer" },
    ]);
    expect(view.readable).toContain("<script>alert(1)</script>");
    expect(view.raw).toContain("javascript:alert(1)");
  });

  it("never parses an incomplete JSON preview and requires an explicit full-output action", () => {
    const output = { data: part('{"published":false,"reason":"partial', true, 12_000), full: false };
    const compact = inspect(renderAutomationSavedOutput(output));
    expect(compact.readable).not.toContain(output.data.value);
    expect(compact.raw).toContain(output.data.value);
    expect(compact.readable).toContain("of 12000 characters");
    expect(compact.tags.filter((tag) => tag.name === "pre").every((tag) => tag.collapsed)).toBe(true);
    expect(compact.tags.filter((tag) => tag.name === "details").every((tag) => !("open" in tag.attributes))).toBe(true);
    expect(compact.tags.some((tag) => tag.name === "dl")).toBe(false);
    expect(compact.tags.some((tag) => tag.name === "button")).toBe(false);
    const selected = inspect(renderAutomationSavedOutput(output, { showFullButton: true }));
    expect(selected.tags.filter((tag) => tag.name === "button").map((tag) => tag.attributes["data-action"]))
      .toEqual(["show-full-step-output"]);
    expect(renderAutomationSavedOutput({ data: part("false"), full: true }, { showFullButton: true }))
      .not.toContain("show-full-step-output");
  });

  it("keeps prose primary when a tool also saves a large partial structured result", () => {
    const data = '{"technical_evidence":"' + "x".repeat(3_978);
    const output = {
      text: part("Path: /work/report.md\nBytes: 480\nWrite: completed"),
      data: part(data, true, 32_000), full: false,
    };
    const view = inspect(renderAutomationSavedOutput(output, { showFullButton: true }));
    expect(view.readable).toContain("Path: /work/report.md");
    expect(view.readable).toContain("Write: completed");
    expect(view.readable).not.toContain("technical_evidence");
    expect(view.readable.length).toBeLessThan(200);
    expect(view.raw).toContain("Additional structured data");
    expect(view.raw).toContain(data);
    expect(view.tags.filter((tag) => tag.name === "pre").every((tag) => tag.collapsed)).toBe(true);
    expect(view.tags.filter((tag) => tag.name === "details").every((tag) => !("open" in tag.attributes))).toBe(true);
    expect(view.tags.filter((tag) => tag.name === "button").map((tag) => tag.attributes["data-action"]))
      .toEqual(["show-full-step-output"]);
  });

  it("bounds deep and wide readable output while retaining every loaded value in raw output", () => {
    let deep: unknown = "deepest-secret-value";
    for (let index = 0; index < 15; index += 1) deep = { next: deep };
    const value = JSON.stringify({ deep, items: Array.from({ length: 250 }, (_, index) => `item-${index}`) });
    const view = inspect(renderAutomationSavedOutput({ data: part(value), full: true }));
    expect(view.readable).toContain("Some nested values are omitted");
    expect(view.readable).not.toContain("deepest-secret-value");
    expect(view.readable).not.toContain("item-249");
    expect(view.tags.filter((tag) => tag.name === "li").length).toBeLessThan(80);
    expect(view.raw).toContain(value);
  });
});
