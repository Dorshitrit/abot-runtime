import { rm, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { build } from "esbuild";
import { afterEach, expect, test } from "vitest";
import { extractBasketDocxText } from "../information-basket/docx-source-reader.js";
import { readBasketSourceDocument } from "../information-basket/source-reader.js";
import { extractDocxText } from "../../plugin-sdk/document-text.js";
import { configureBasket, createBasketFixture, waitForBasketSource } from "./support/information-basket-fixture.js";

const fixtures: Awaited<ReturnType<typeof createBasketFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
async function docx(text: string, extra: Record<string, string> = {}) {
  const zip = new JSZip();
  zip.file("word/document.xml", `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  for (const [name, xml] of Object.entries(extra)) zip.file(name, xml);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
async function fixture() {
  const f = await createBasketFixture(); fixtures.push(f);
  await configureBasket(f.service);
  return f;
}

test("DOCX indexes, searches and reads without loading any installed plugin", async () => {
  const f = await fixture();
  const bytes = await docx("סיכום שכר &amp; הכנסות", {
    "word/header1.xml": "<w:hdr><w:p><w:r><w:t>Account header</w:t></w:r></w:p></w:hdr>",
    "word/footnotes.xml": "<w:footnotes><w:p><w:r><w:t>Footnote</w:t></w:r></w:p></w:footnotes>",
  });
  const path = await f.source("source.DOCX", bytes);
  expect((await f.service.list()).supportedExtensions).toContain(".docx");
  await f.service.addSources({ paths: [path] });
  const source = await waitForBasketSource(f.service);
  const result = await f.service.readSource({ sourceId: source.sourceId, expectedRevision: source.revision });
  expect(result.text).toContain("סיכום שכר & הכנסות");
  expect(result.text).toContain("Account header");
  expect(result.text).toContain("Footnote");
  expect(f.embed.mock.calls.flatMap(([input]) => input.texts).join(" ")).toContain("סיכום שכר & הכנסות");
  const matches = await f.service.search({ query: "שכר", includeExcerpts: false, abortSignal: new AbortController().signal });
  expect(matches.sources.map(match => match.sourceId)).toContain(source.sourceId);
  await writeFile(path, await docx("A changed document"));
  await expect(f.service.readSource({ sourceId: source.sourceId, expectedRevision: source.revision })).rejects.toBeDefined();
});

test("Resource extraction has no dependency on plugin code or a plugin loader", async () => {
  const bundled = await build({
    entryPoints: ["src/runtime/information-basket/docx-source-reader.ts"],
    bundle: true, write: false, metafile: true, platform: "node", packages: "external",
  });
  const inputs = Object.keys(bundled.metafile!.inputs);
  expect(inputs.some(path => path.startsWith("src/shared/document-text/"))).toBe(true);
  expect(inputs.filter(path => path.startsWith("plugins/") || path.startsWith("src/runtime/plugins/"))).toEqual([]);
});

test("Resources rejects truncated extraction while SDK consumers retain honest coverage", async () => {
  const bytes = await docx("a".repeat(750_001));
  const partial = await extractDocxText(bytes, 20);
  expect(partial.text).toHaveLength(20);
  expect(partial.textBounds).toMatchObject({ truncated: true, totalCharacters: 750_001, returnedCharacters: 20 });
  await expect(extractBasketDocxText(bytes)).rejects.toMatchObject({ code: "basket_source_text_too_large" });
});

test("invalid DOCX never becomes ready and has a format-specific error", async () => {
  const f = await fixture();
  const path = await f.source("broken.docx", "not a ZIP archive");
  await f.service.addSources({ paths: [path] });
  const failed = await waitForBasketSource(f.service, "failed");
  expect(failed.reason).toContain("basket_docx_archive_invalid");
  expect(f.embed).not.toHaveBeenCalled();
  expect((await f.service.search({ query: "anything", abortSignal: new AbortController().signal })).sources).toEqual([]);
});

test("rejects empty, oversized archive declarations and cancelled DOCX reads", async () => {
  const f = await fixture();
  const empty = await f.source("empty.docx", await docx(""));
  await expect(readBasketSourceDocument(empty)).rejects.toMatchObject({ code: "basket_source_no_extractable_text" });
  const bytes = Buffer.from(await docx("body"));
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(257 * 1024 * 1024, central + 24);
  await expect(extractBasketDocxText(bytes)).rejects.toMatchObject({ code: "basket_docx_archive_expansion_limit" });
  const abort = new AbortController(); abort.abort();
  await expect(extractBasketDocxText(bytes, abort.signal)).rejects.toBeDefined();
});


test.each([
  ["truncated document", "word/document.xml", "<w:document><w:body><w:p><w:r><w:t>Only surviving prefix"],
  ["plain text", "word/document.xml", "not XML at all"],
  ["mismatched tags", "word/document.xml", "<w:document><w:body>prefix</w:document>"],
  ["unclosed comment", "word/document.xml", "<w:document><!-- incomplete"],
  ["extra root", "word/document.xml", "<w:document>one</w:document><w:document>two</w:document>"],
  ["truncated header", "word/header1.xml", "<w:hdr><w:p><w:r><w:t>partial header"],
])("malformed DOCX %s is rejected before extraction or index publication", async (_label, part, xml) => {
  const zip = await JSZip.loadAsync(await docx("Complete body"));
  zip.file(part, xml);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  await expect(extractDocxText(bytes, 10_000)).rejects.toMatchObject({ code: "document_xml_invalid" });
  const f = await fixture();
  const path = await f.source("malformed.docx", bytes);
  await f.service.addSources({ paths: [path] });
  expect((await waitForBasketSource(f.service, "failed")).reason).toBe("basket_docx_xml_invalid");
  expect(f.embed).not.toHaveBeenCalled();
  expect((await f.service.search({ query: "prefix", abortSignal: new AbortController().signal })).sources).toEqual([]);
});
