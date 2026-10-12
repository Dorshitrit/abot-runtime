import JSZip from "jszip";

async function zipBytes(files: Readonly<Record<string, string>>) {
  const zip = new JSZip();
  for (const [name, contents] of Object.entries(files)) {
    zip.file(name, contents);
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function minimalPdf(text: string): Buffer {
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

export const DOCUMENT_FORMATS = [
  "txt",
  "md",
  "csv",
  "json",
  "rtf",
  "docx",
  "pptx",
  "xlsx",
  "pdf",
] as const;

export async function platformDocument(
  format: (typeof DOCUMENT_FORMATS)[number],
) {
  switch (format) {
    case "txt":
      return { bytes: "Plain body", expected: "Plain body" };
    case "md":
      return { bytes: "# Markdown body", expected: "Markdown body" };
    case "csv":
      return { bytes: "name,value\\r\\nalpha,1", expected: "alpha,1" };
    case "json":
      return { bytes: '{"ready":true}', expected: '"ready": true' };
    case "rtf":
      return { bytes: "{\\\\rtf1 RTF body}", expected: "RTF body" };
    case "pdf":
      return { bytes: minimalPdf("PDF body"), expected: "PDF body" };
    case "docx":
      return {
        bytes: await zipBytes({
          "word/document.xml":
            '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Word body</w:t></w:r></w:p></w:body></w:document>',
        }),
        expected: "Word body",
      };
    case "pptx":
      return {
        bytes: await zipBytes({
          "ppt/slides/slide1.xml":
            '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Slide body</a:t></p:sld>',
        }),
        expected: "Slide body",
      };
    case "xlsx":
      return {
        bytes: await zipBytes({
          "xl/sharedStrings.xml": "<sst><si><t>Cell body</t></si></sst>",
          "xl/worksheets/sheet1.xml":
            '<worksheet><row><c t="s"><v>0</v></c></row></worksheet>',
        }),
        expected: "Cell body",
      };
  }
}
