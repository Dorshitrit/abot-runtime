import { describe, expect, test } from "vitest";
import { ProviderSseDiagnostics } from "./provider-sse-diagnostics.js";

describe("SSE diagnostic framing", () => {
  test("ignores data-less frames and resets their event type", () => {
    const capture = new ProviderSseDiagnostics();
    capture.observe("event: ping\n\n: heartbeat\n\nid: 42\n\n", 10);
    expect(capture.snapshot().eventCount).toBe(0);
    capture.observe("data: payload\n\n", 20);
    expect(capture.snapshot()).toMatchObject({
      eventCount: 1, eventTypes: { message: 1 }, recentEvents: [{ type: "message", afterMs: 20 }],
    });
  });

  test("counts empty data fields with and without a colon", () => {
    const capture = new ProviderSseDiagnostics();
    capture.observe("data:\n\ndata\n\n", 10);
    expect(capture.snapshot()).toMatchObject({ eventCount: 2, eventTypes: { message: 2 } });
  });

  test.each(["event", "event:", "event: "])("resets the event type for an empty %j field", (field) => {
    for (const lines of [
      ["event: foo", field, "data: payload"],
      ["event: foo", "data: payload", field],
    ]) {
      const text = [...lines, "", "event: next", "data: payload", "", ""].join("\n");
      for (let split = 0; split <= text.length; split += 1) {
        const capture = new ProviderSseDiagnostics();
        capture.observe(text.slice(0, split), 10);
        capture.observe(text.slice(split), 20);
        expect(capture.snapshot()).toMatchObject({
          eventCount: 2, eventTypes: { message: 1, next: 1 },
        });
      }
    }
  });

  test.each(["\n", "\r", "\r\n"])("recognizes %j terminators across every chunk split", (newline) => {
    const text = ["event: first", "data: one", "", "data: two", "", ""].join(newline);
    for (let split = 0; split <= text.length; split += 1) {
      const capture = new ProviderSseDiagnostics();
      capture.observe(text.slice(0, split), 10);
      capture.observe("", 15);
      capture.observe(text.slice(split), 20);
      expect(capture.snapshot()).toMatchObject({ eventCount: 2, eventTypes: { first: 1, message: 1 } });
    }
  });

  test("handles mixed terminators delivered one character at a time", () => {
    const capture = new ProviderSseDiagnostics();
    const text = "event: ping\r\rdata: one\r\n\r\ndata: two\n\ndata: three\r\r";
    for (const character of text) capture.observe(character, 10);
    expect(capture.snapshot()).toMatchObject({ eventCount: 3, eventTypes: { message: 3 } });
  });

  test("does not turn oversized comments and unknown fields into data", () => {
    const capture = new ProviderSseDiagnostics();
    capture.observe("event: ping\n:" + "x".repeat(40_000) + "\n\n", 10);
    capture.observe("unknown:" + "x".repeat(40_000) + "\n\n", 20);
    capture.observe("data: real event\n\n", 30);
    expect(capture.snapshot()).toMatchObject({
      eventCount: 1, eventTypes: { message: 1 }, oversizedLineCount: 2,
    });
  });

  test("does not dispatch an unterminated frame", () => {
    const capture = new ProviderSseDiagnostics();
    capture.observe("event: first\ndata: unfinished\n", 10);
    expect(capture.snapshot().eventCount).toBe(0);
  });

  test.each([
    ["event: response.completed ", "response.completed "],
    ["event:  response.completed", " response.completed"],
    ["event:\tresponse.completed", "\tresponse.completed"],
    ["event: \tresponse.completed\t", "\tresponse.completed\t"],
    ["event: \u00a0response.completed\u00a0", "\u00a0response.completed\u00a0"],
    ["event:  ", " "],
  ])("preserves significant whitespace in %j", (field, type) => {
    const capture = new ProviderSseDiagnostics();
    capture.observe(`${field}\ndata: {}\n\n`, 10);
    expect(capture.snapshot().eventTypes).toEqual({ [type]: 1 });
  });

  test.each([
    ['data: {\ndata: "type": "response.completed"}', "response.completed"],
    ['data: {"type":\ndata\ndata: "response.completed"}', "response.completed"],
    ['data: {"type":"first"}\ndata: {"type":"second"}', "message"],
    ['data: {"type":"first"}\nevent: second', "second"],
    ['event: first\ndata: {"type":"second"}', "first"],
    ['event\ndata: {"type":"second"}', "message"],
    ['data: {"type":"second"}\nevent:', "message"],
    ['data: [DONE]', "[DONE]"],
    ['data: [DONE]\ndata: extra', "message"],
    ['Data: ignored\nEVENT: ignored\n: comment\nid: id\nretry: 100\ndata: plain', "message"],
    ['data: {"type":1}', "message"],
  ])("classifies the complete frame %j across chunk splits", (fields, type) => {
    for (const ending of ["\n", "\r", "\r\n"]) {
      const text = fields.replaceAll("\n", ending) + ending + ending;
      for (let split = 0; split <= text.length; split += 1) {
        const capture = new ProviderSseDiagnostics();
        capture.observe(text.slice(0, split), 10);
        capture.observe(text.slice(split), 20);
        expect(capture.snapshot()).toMatchObject({ eventCount: 1, eventTypes: { [type]: 1 } });
      }
    }
  });
});
