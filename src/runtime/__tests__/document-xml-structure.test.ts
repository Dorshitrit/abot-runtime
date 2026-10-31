import { expect, test } from "vitest";
import { assertDocumentXmlStructure } from "../../shared/document-text/xml-validation.js";

test.each([
  '<w:document xmlns:w="urn:word"><w:body><w:br/></w:body></w:document>',
  '\ufeff<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document />',
  `<root a="1 > 0" b='quoted "value"'><child>text &amp; more</child></root>`,
  '<!-- before --><root><!-- <unfinished> --><![CDATA[<not-markup>]]></root><!-- after -->',
])("accepts complete DOCX XML structure: %s", xml => {
  expect(() => assertDocumentXmlStructure(xml)).not.toThrow();
});

test.each([
  '', '<root>', '<root><child></root>', '<root/><other/>',
  'text<root/>', '<root/>text', '<root></root><',
  '<root a="unfinished></root>', '<root><!-- unfinished</root>',
  '<root><![CDATA[unfinished</root>', '<?xml version="1.0"<root/>',
  '<root></root extra="no">', '<root></root/>',
  '<!DOCTYPE root><root/>', '<![CDATA[outside]]><root/>',
])("rejects incomplete or unsupported DOCX XML structure: %s", xml => {
  expect(() => assertDocumentXmlStructure(xml)).toThrow(expect.objectContaining({ code: "document_xml_invalid" }));
});
