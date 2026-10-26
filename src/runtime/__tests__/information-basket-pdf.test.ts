import { writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { extractBasketPdfText } from "../information-basket/pdf-source-reader.js";
import { configureBasket, createBasketFixture, waitForBasketSource } from "./support/information-basket-fixture.js";
import { platformDocument } from "./document-reader-platform-fixtures.js";

const fixtures: Awaited<ReturnType<typeof createBasketFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.stop();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
describe("Information Basket PDF sources", () => {
  test("the source runtime extracts PDF text under tsx and retains invalid-content errors", async () => {
    const { bytes, expected } = await platformDocument("pdf");
    const readerUrl = new URL("../information-basket/pdf-source-reader.ts", import.meta.url).href;
    const script = [
      "const { extractBasketPdfText } = await import(" + JSON.stringify(readerUrl) + ");",
      "const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);",
      "try { process.stdout.write(JSON.stringify({ text: await extractBasketPdfText(Buffer.concat(chunks)) })); }",
      "catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }",
    ].join(" ");
    for (const input of [Buffer.from(bytes), Buffer.from("%PDF-broken")]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        input, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      if (input.equals(Buffer.from(bytes))) expect(output.text).toContain(expected);
      else expect(output).toEqual({ code: "basket_pdf_content_invalid" });
    }
  }, 35_000);

  test("extracts a real PDF through an isolated process and indexes/reads its original", async () => {
    const { bytes, expected } = await platformDocument("pdf");
    expect(await extractBasketPdfText(Buffer.from(bytes))).toContain(expected);
    const fixture = await createBasketFixture();
    fixtures.push(fixture);
    await configureBasket(fixture.service);
    const path = await fixture.source("source.pdf", bytes);
    await fixture.service.addSources({ paths: [path] });
    const source = await waitForBasketSource(fixture.service);
    const read = await fixture.service.readSource({ sourceId: source.sourceId, expectedRevision: source.revision });
    expect(read.text).toContain(expected);
    await writeFile(path, Buffer.from("broken PDF"));
    await expect(fixture.service.readSource({ sourceId: source.sourceId, expectedRevision: source.revision })).rejects.toBeDefined();
  }, 20_000);

  test("settles active cancellation only after stopping its parser process", async () => {
    const { bytes } = await platformDocument("pdf");
    const controller = new AbortController();
    const pending = extractBasketPdfText(Buffer.from(bytes), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "basket_source_read_cancelled" });
    expect(await extractBasketPdfText(Buffer.from(bytes))).toContain("PDF body");
  });

  test("rejects malformed and pre-cancelled PDF input explicitly", async () => {
    await expect(extractBasketPdfText(Buffer.from("%PDF-broken"))).rejects.toMatchObject({ code: "basket_pdf_content_invalid" });
    const controller = new AbortController();
    controller.abort();
    await expect(extractBasketPdfText(Buffer.from("%PDF-broken"), controller.signal)).rejects.toBeDefined();
  });
});
