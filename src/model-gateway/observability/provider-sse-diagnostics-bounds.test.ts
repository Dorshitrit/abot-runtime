import { describe, expect, test } from "vitest";
import { ProviderSseDiagnostics } from "./provider-sse-diagnostics.js";

describe("bounded SSE frame interpretation", () => {
  test.each([1, 4093, 32768, 100000])("retains the latest oversized event prefix with %i-character chunks", (chunkSize) => {
    const capture = new ProviderSseDiagnostics();
    const type = "new ".repeat(10_000);
    const text = `event: old\nevent: ${type}\ndata: {}\n\nevent: next\ndata: {}\n\n`;
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      capture.observe(text.slice(offset, offset + chunkSize), 10);
    }
    expect(capture.snapshot()).toMatchObject({
      eventCount: 2, oversizedLineCount: 1,
      eventTypes: { [type.slice(0, 128)]: 1, next: 1 },
    });
  });

  test("does not infer a type from the prefix of oversized data", () => {
    const capture = new ProviderSseDiagnostics();
    capture.observe('data: {"type":"false-terminal"}' + " ".repeat(40_000) + 'extra\n\n', 10);
    capture.observe('data: {\ndata: "type":"next"}\n\n', 20);
    expect(capture.snapshot()).toMatchObject({
      eventCount: 2, oversizedLineCount: 1, eventTypes: { message: 1, next: 1 },
    });
  });

  test("bounds aggregate data even when every line is short and resets at the next frame", () => {
    const capture = new ProviderSseDiagnostics();
    capture.observe('data: {"type":"false-terminal"}\n', 10);
    for (let line = 0; line < 40_000; line += 1) capture.observe("data\n", 10);
    capture.observe('data: extra\n\ndata: {"type":"next"}\n\n', 20);
    expect(capture.snapshot()).toMatchObject({
      eventCount: 2, oversizedLineCount: 0, eventTypes: { message: 1, next: 1 },
    });
  });

  test.each([32768, 32769])("classifies data only when the entire %i-character buffer fits", (size) => {
    const capture = new ProviderSseDiagnostics();
    const json = '{"type":"complete"}';
    const data = json + " ".repeat(size - json.length - 1);
    // Keep each individual line below the line limit.
    capture.observe(`data: ${data.slice(0, 100)}\ndata: ${data.slice(101)}\n\n`, 10);
    const type = size === 32768 ? "complete" : "message";
    expect(capture.snapshot().eventTypes).toEqual({ [type]: 1 });
  });
});
