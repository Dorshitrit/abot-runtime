import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { InformationBasketError } from "./contracts.js";
import { BASKET_LIMITS } from "./limits.js";
import { BASKET_PDF_PROCESS_SOURCE } from "./pdf-source-parser.js";

function parseBasketPdfOutput(bytes: Buffer): string {
  let message: unknown;
  try { message = JSON.parse(bytes.toString("utf8")); }
  catch { throw new InformationBasketError("basket_pdf_protocol_invalid"); }
  if (!message || typeof message !== "object")
    throw new InformationBasketError("basket_pdf_protocol_invalid");
  const value = message as { kind?: unknown; code?: unknown; text?: unknown };
  if (value.kind === "failure") {
    const known = new Set([
      "basket_pdf_resource_limit", "basket_pdf_input_too_large", "basket_pdf_protocol_invalid",
      "basket_pdf_content_invalid", "basket_pdf_page_limit", "basket_source_text_too_large",
    ]);
    const code = typeof value.code === "string" && known.has(value.code)
      ? value.code : "basket_pdf_content_invalid";
    throw new InformationBasketError(code);
  }
  if (value.kind !== "success" || typeof value.text !== "string")
    throw new InformationBasketError("basket_pdf_protocol_invalid");
  if (value.text.length > BASKET_LIMITS.maxTextCharacters)
    throw new InformationBasketError("basket_source_text_too_large");
  return value.text;
}

/** Same installed parser as Document Reader; source bytes travel only through pipes. */
export async function extractBasketPdfText(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (bytes.byteLength > BASKET_LIMITS.maxSourceBytes)
    throw new InformationBasketError("basket_source_too_large");
  const limits = {
    maxInputBytes: BASKET_LIMITS.maxSourceBytes,
    maxTextCharacters: BASKET_LIMITS.maxTextCharacters,
    maxPages: BASKET_LIMITS.maxPdfPages,
  };
  const parser = createRequire(import.meta.url).resolve("pdf-parse");
  const child = spawn(process.execPath, [
    "--input-type=commonjs", "--max-old-space-size=128", "--max-semi-space-size=4",
    "--stack-size=4096", "--eval", "(" + BASKET_PDF_PROCESS_SOURCE + ")(" + JSON.stringify(limits) + ")",
  ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      chunks.length = 0;
      child.stdin.destroy();
      child.kill("SIGKILL");
    };
    const onAbort = () => stop(new InformationBasketError("basket_source_read_cancelled"));
    const timeout = setTimeout(() => stop(new InformationBasketError("basket_pdf_timeout")),
      BASKET_LIMITS.pdfTimeoutMs);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      outputBytes += chunk.length;
      if (outputBytes > BASKET_LIMITS.maxTextCharacters * 6 + 1024) {
        stop(new InformationBasketError("basket_pdf_output_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", () => stop(new InformationBasketError("basket_pdf_process_unavailable")));
    child.stdout.on("error", () => stop(new InformationBasketError("basket_pdf_process_unavailable")));
    child.stderr.on("error", () => stop(new InformationBasketError("basket_pdf_process_unavailable")));
    child.on("error", () => stop(new InformationBasketError("basket_pdf_process_unavailable")));
    child.once("close", (code, killedBy) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (failure) { reject(failure); return; }
      if (code !== 0 || killedBy !== null) {
        reject(new InformationBasketError("basket_pdf_process_unavailable"));
        return;
      }
      try { resolve(parseBasketPdfOutput(Buffer.concat(chunks, outputBytes))); }
      catch (error) { reject(error); }
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    child.stdin.write(JSON.stringify({ parser }) + "\n");
    child.stdin.end(Buffer.from(bytes));
  });
}
