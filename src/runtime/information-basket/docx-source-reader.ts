import { extractDocxText } from "../../shared/document-text/ooxml.js";
import { DocumentTextError } from "../../shared/document-text/errors.js";
import { InformationBasketError } from "./contracts.js";
import { BASKET_LIMITS } from "./limits.js";

export async function extractBasketDocxText(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (bytes.byteLength > BASKET_LIMITS.maxSourceBytes)
    throw new InformationBasketError("basket_source_too_large");
  try {
    const result = await extractDocxText(bytes, BASKET_LIMITS.maxTextCharacters, signal);
    signal?.throwIfAborted();
    if (result.textBounds.truncated)
      throw new InformationBasketError("basket_source_text_too_large");
    return result.text;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof DocumentTextError)
      throw new InformationBasketError(error.code.replace(/^document_/, "basket_docx_"));
    throw error;
  }
}
