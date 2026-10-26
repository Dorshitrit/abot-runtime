/** Fixed JavaScript for the isolated process; never serialize transpiled functions. */
export const BASKET_PDF_PROCESS_SOURCE = String.raw`async function runBasketPdfProcess(limits) {
  console.log = console.warn = console.error = () => undefined;
  let parser;
  const fail = (code) => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };
  try {
    const heap = require("node:v8").getHeapStatistics().heap_size_limit;
    if (heap > 144 * 1024 * 1024) fail("basket_pdf_resource_limit");
    const parts = [];
    let size = 0;
    for await (const raw of process.stdin) {
      const part = Buffer.from(raw);
      size += part.length;
      if (size > limits.maxInputBytes + 65_537) fail("basket_pdf_input_too_large");
      parts.push(part);
    }
    const input = Buffer.concat(parts, size);
    const separator = input.indexOf(10);
    if (separator < 0 || separator > 65_536) fail("basket_pdf_protocol_invalid");
    const header = JSON.parse(input.subarray(0, separator).toString("utf8"));
    const bytes = input.subarray(separator + 1);
    if (bytes.length > limits.maxInputBytes) fail("basket_pdf_input_too_large");
    const { PDFParse } = require(header.parser);
    parser = new PDFParse({ data: new Uint8Array(bytes), isEvalSupported: false, stopAtErrors: true });
    const info = await parser.getInfo();
    if (!Number.isSafeInteger(info.total) || info.total < 0) fail("basket_pdf_content_invalid");
    if (info.total > limits.maxPages) fail("basket_pdf_page_limit");
    const text = [];
    let characters = 0;
    let processedPages = 0;
    for (let first = 1; first <= info.total; first += 8) {
      const partial = Array.from({ length: Math.min(8, info.total - first + 1) }, (_, i) => first + i);
      const batch = await parser.getText({ partial, pageJoiner: "" });
      if (!Array.isArray(batch.pages) || batch.pages.length !== partial.length)
        fail("basket_pdf_content_invalid");
      for (const page of batch.pages) {
        if (typeof page.text !== "string") fail("basket_pdf_content_invalid");
        processedPages++;
        const pageText = page.text.replaceAll("\0", "").trim();
        if (!pageText) continue;
        characters += pageText.length + (text.length ? 2 : 0);
        if (characters > limits.maxTextCharacters) fail("basket_source_text_too_large");
        text.push(pageText);
      }
    }
    if (processedPages !== info.total) fail("basket_pdf_content_invalid");
    await parser.destroy();
    parser = undefined;
    process.stdout.end(JSON.stringify({ kind: "success", text: text.join("\n\n") }), () => process.exit(0));
  } catch (error) {
    if (parser) await parser.destroy().catch(() => undefined);
    const code = error.code;
    const allowed = new Set([
      "basket_pdf_resource_limit", "basket_pdf_input_too_large", "basket_pdf_protocol_invalid",
      "basket_pdf_content_invalid", "basket_pdf_page_limit", "basket_source_text_too_large",
    ]);
    process.stdout.end(JSON.stringify({
      kind: "failure", code: code && allowed.has(code) ? code : "basket_pdf_content_invalid",
    }), () => process.exit(0));
  }
}`;
