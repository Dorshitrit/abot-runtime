import {
  archiveMetadata,
  loadOfficeArchive,
  readBoundedXml,
  type LoadedOfficeArchive,
} from "./archive.js";
import {
  BoundedTextAccumulator,
  normalizeExtractedText,
} from "./text-accumulator.js";
import type { ExtractedDocument } from "./types.js";

function decodeCodePoint(value: string, radix: number): string {
  const parsed = Number.parseInt(value, radix);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0x10ffff) {
    return "\ufffd";
  }
  return String.fromCodePoint(parsed);
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => decodeCodePoint(hex, 16))
    .replace(/&#(\d+);/gu, (_, decimal: string) => decodeCodePoint(decimal, 10))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function extractTextNodes(xml: string, tag: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "giu",
  );
  for (const match of xml.matchAll(pattern)) {
    values.push(decodeXml((match[1] ?? "").replace(/<[^>]+>/gu, "")));
  }
  return values;
}

function numericSuffix(name: string): number {
  return Number(name.match(/(\d+)\.xml$/u)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function archiveResult(
  accumulator: BoundedTextAccumulator,
  archive: LoadedOfficeArchive,
): ExtractedDocument {
  return accumulator.finish(
    Object.freeze({
      kind: "archive",
      archive: archiveMetadata(archive),
    }),
  );
}

export async function extractDocxText(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ExtractedDocument> {
  const archive = await loadOfficeArchive(bytes);
  const names = Object.keys(archive.zip.files)
    .filter((name) =>
      /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u.test(
        name,
      ),
    )
    .sort((left, right) =>
      left === "word/document.xml"
        ? -1
        : right === "word/document.xml"
          ? 1
          : left.localeCompare(right),
    );
  const accumulator = new BoundedTextAccumulator();
  for (const name of names) {
    const entry = archive.zip.file(name);
    if (!entry) continue;
    const xml = await readBoundedXml(entry, archive.budget, signal);
    const normalized = xml
      .replace(/<w:tab\b[^>]*\/>/giu, "\t")
      .replace(/<w:br\b[^>]*\/>/giu, "\n")
      .replace(/<\/w:tc>/giu, "\t")
      .replace(/<\/w:p>/giu, "\n");
    const text = normalizeExtractedText(
      decodeXml(
        normalized
          .replace(/<(?!\/?w:t\b)[^>]+>/giu, "")
          .replace(/<\/?w:t\b[^>]*>/giu, ""),
      )
        .replace(/[ \t]+\n/gu, "\n")
        .replace(/\n{3,}/gu, "\n\n"),
    );
    accumulator.append(text);
  }
  return archiveResult(accumulator, archive);
}

export async function extractPptxText(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ExtractedDocument> {
  const archive = await loadOfficeArchive(bytes);
  const names = Object.keys(archive.zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
    .sort((left, right) => numericSuffix(left) - numericSuffix(right));
  const accumulator = new BoundedTextAccumulator();
  for (const [index, name] of names.entries()) {
    const entry = archive.zip.file(name);
    if (!entry) continue;
    const xml = await readBoundedXml(entry, archive.budget, signal);
    const content = normalizeExtractedText(
      extractTextNodes(xml, "a:t").filter(Boolean).join("\n"),
    );
    accumulator.append(`[Slide ${index + 1}]${content ? `\n${content}` : ""}`);
  }
  return archiveResult(accumulator, archive);
}

function cellValue(
  attributes: string,
  body: string,
  sharedStrings: readonly string[],
): string {
  const type = attributes.match(/\bt="([^"]+)"/u)?.[1];
  const rawValue = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/iu)?.[1];
  if (type === "s" && rawValue !== undefined) {
    const index = Number(rawValue);
    return Number.isSafeInteger(index) && index >= 0
      ? (sharedStrings[index] ?? rawValue)
      : rawValue;
  }
  if (type === "inlineStr") return extractTextNodes(body, "t").join("");
  return decodeXml(rawValue ?? "");
}

export async function extractXlsxText(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ExtractedDocument> {
  const archive = await loadOfficeArchive(bytes);
  const sharedStrings: string[] = [];
  const sharedEntry = archive.zip.file("xl/sharedStrings.xml");
  if (sharedEntry) {
    const sharedXml = await readBoundedXml(sharedEntry, archive.budget, signal);
    for (const match of sharedXml.matchAll(
      /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/giu,
    )) {
      sharedStrings.push(extractTextNodes(match[1] ?? "", "t").join(""));
    }
  }

  const sheetNames = Object.keys(archive.zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
    .sort((left, right) => numericSuffix(left) - numericSuffix(right));
  const accumulator = new BoundedTextAccumulator();
  for (const [index, name] of sheetNames.entries()) {
    const entry = archive.zip.file(name);
    if (!entry) continue;
    const xml = await readBoundedXml(entry, archive.budget, signal);
    const rows: string[] = [];
    for (const rowMatch of xml.matchAll(
      /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/giu,
    )) {
      const cells: string[] = [];
      for (const cellMatch of (rowMatch[1] ?? "").matchAll(
        /<c([^>]*)>([\s\S]*?)<\/c>/giu,
      )) {
        cells.push(
          cellValue(cellMatch[1] ?? "", cellMatch[2] ?? "", sharedStrings),
        );
      }
      rows.push(cells.join("\t"));
    }
    const content = normalizeExtractedText(rows.join("\n"));
    accumulator.append(`[Sheet ${index + 1}]${content ? `\n${content}` : ""}`);
  }
  return archiveResult(accumulator, archive);
}
