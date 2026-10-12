import type { PdfParserInput, PdfWorkerMessage } from "./pdf-contract.js";

// Serialized into the isolated parser. Keep runtime dependencies inside this function.
export async function runPdfParser(
  data: PdfParserInput,
  publish: (message: PdfWorkerMessage) => void,
): Promise<void> {
  const fail = (code: string, message: string): never => {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    throw error;
  };

  const boundedMessage = (value: unknown): string => {
    const message = value instanceof Error ? value.message : String(value);
    return message.slice(0, data.limits.maxErrorMessageCharacters);
  };

  let parser:
    | InstanceType<(typeof import("pdf-parse"))["PDFParse"]>
    | undefined;
  try {
    const { PDFParse } = require(
      data.pdfParseEntrypoint,
    ) as typeof import("pdf-parse");
    parser = new PDFParse({
      data: new Uint8Array(data.bytes),
      isEvalSupported: false,
      stopAtErrors: true,
    });
    const info = await parser.getInfo();
    const totalPages = info.total;
    if (!Number.isSafeInteger(totalPages) || totalPages < 0) {
      fail("document_content_invalid", "The PDF page index is invalid.");
    }
    if (totalPages > data.limits.maxPages) {
      fail(
        "document_pdf_page_limit",
        `The PDF exceeds the ${data.limits.maxPages}-page parsing limit.`,
      );
    }

    const retainedParts: string[] = [];
    let retainedCharacters = 0;
    let totalCharacters = 0;
    let processedPages = 0;
    let hasContent = false;

    const append = (rawValue: string): void => {
      const value = rawValue.replaceAll("\u0000", "").trim();
      if (value.length === 0) return;
      const separator = hasContent ? "\n\n" : "";
      hasContent = true;
      const nextTotal = totalCharacters + separator.length + value.length;
      if (!Number.isSafeInteger(nextTotal)) {
        fail(
          "document_pdf_resource_limit",
          "The PDF text exceeds the supported character range.",
        );
      }
      totalCharacters = nextTotal;
      let remaining = data.limits.maxRetainedCharacters - retainedCharacters;
      if (remaining <= 0) return;
      if (separator.length > 0) {
        const retainedSeparator = separator.slice(0, remaining);
        retainedParts.push(retainedSeparator);
        retainedCharacters += retainedSeparator.length;
        remaining -= retainedSeparator.length;
      }
      if (remaining > 0) {
        const retainedValue = value.slice(0, remaining);
        retainedParts.push(retainedValue);
        retainedCharacters += retainedValue.length;
      }
    };

    for (
      let firstPage = 1;
      firstPage <= totalPages;
      firstPage += data.limits.pageBatchSize
    ) {
      const pageNumbers = Array.from(
        {
          length: Math.min(
            data.limits.pageBatchSize,
            totalPages - firstPage + 1,
          ),
        },
        (_, index) => firstPage + index,
      );
      const batch = await parser.getText({
        partial: pageNumbers,
        pageJoiner: "",
      });
      if (!Array.isArray(batch.pages)) {
        fail(
          "document_content_invalid",
          "The PDF page set could not be extracted.",
        );
      }
      for (const page of batch.pages) {
        if (typeof page?.text !== "string") {
          fail("document_content_invalid", "The PDF page text is invalid.");
        }
        processedPages += 1;
        append(page.text);
      }
    }
    if (processedPages !== totalPages) {
      fail(
        "document_content_invalid",
        "The PDF page set could not be extracted completely.",
      );
    }
    publish({
      kind: "success",
      text: retainedParts.join(""),
      totalCharacters,
      returnedCharacters: retainedCharacters,
      totalPages,
      processedPages,
    } satisfies Extract<PdfWorkerMessage, { kind: "success" }>);
  } catch (error) {
    const candidateCode =
      error instanceof Error &&
      typeof (error as Error & { code?: unknown }).code === "string"
        ? (error as Error & { code: string }).code
        : undefined;
    publish({
      kind: "failure",
      ...(candidateCode ? { code: candidateCode } : {}),
      message: boundedMessage(error),
    } satisfies Extract<PdfWorkerMessage, { kind: "failure" }>);
  } finally {
    if (parser) {
      await parser.destroy().catch(() => undefined);
    }
  }
}
