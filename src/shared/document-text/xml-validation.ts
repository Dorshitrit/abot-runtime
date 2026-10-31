import { failDocumentText } from "./errors.js";

function rejectIncompleteDocumentXml(): never {
  return failDocumentText("document_xml_invalid", "The document contains malformed XML.");
}

function documentXmlSectionEnd(xml: string, start: number, terminator: string): number {
  const end = xml.indexOf(terminator, start);
  if (end < 0) rejectIncompleteDocumentXml();
  return end + terminator.length;
}

/** Bounded structural guard for DOCX parts, not a full XML/schema validator. */
export function assertDocumentXmlStructure(xml: string): void {
  const openTags: string[] = [];
  // Quoted attribute values may contain >; a tag must be consumed in full.
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*(\/?)>/uy;
  let cursor = 0;
  let hasRoot = false;

  while (cursor < xml.length) {
    const nextTag = xml.indexOf("<", cursor);
    const textEnd = nextTag < 0 ? xml.length : nextTag;
    if (openTags.length === 0 && xml.slice(cursor, textEnd).trim()) {
      rejectIncompleteDocumentXml();
    }
    cursor = textEnd;
    if (cursor === xml.length) break;

    if (xml.startsWith("<!--", cursor)) {
      cursor = documentXmlSectionEnd(xml, cursor + 4, "-->");
      continue;
    }
    if (xml.startsWith("<![CDATA[", cursor)) {
      if (openTags.length === 0) rejectIncompleteDocumentXml();
      cursor = documentXmlSectionEnd(xml, cursor + 9, "]]>");
      continue;
    }
    if (xml.startsWith("<?", cursor)) {
      cursor = documentXmlSectionEnd(xml, cursor + 2, "?>");
      continue;
    }

    tag.lastIndex = cursor;
    const match = tag.exec(xml);
    if (!match) rejectIncompleteDocumentXml();
    cursor = tag.lastIndex;
    const [, closing, name, selfClosing] = match;
    if (closing) {
      if (!/^<\/[A-Za-z_][\w.:-]*\s*>$/u.test(match[0])) rejectIncompleteDocumentXml();
      if (openTags.pop() !== name) rejectIncompleteDocumentXml();
      continue;
    }
    if (openTags.length === 0 && hasRoot) rejectIncompleteDocumentXml();
    hasRoot = true;
    if (!selfClosing) openTags.push(name!);
  }

  if (!hasRoot || openTags.length > 0) rejectIncompleteDocumentXml();
}
