import { expect, test } from "vitest";
import { readOpenAIHttpContextOverflow, readOpenAIStreamContextOverflow } from "./context-overflow.js";
import { PROVIDER_CONTEXT_OVERFLOW } from "../../protocol/provider-context-overflow.js";

const overflow = { code: "context_length_exceeded", type: "invalid_request_error", message: "Reduce input." };

const readOptedInHttpOverflow = (status: number, body: string) =>
  readOpenAIHttpContextOverflow(status, body, true);
const readOptedInStreamOverflow = (event: unknown) =>
  readOpenAIStreamContextOverflow(event, true);

test("classification is disabled unless the provider adapter opts in", () => {
  expect(readOpenAIHttpContextOverflow(400, JSON.stringify({ error: overflow }))).toBeUndefined();
  expect(readOpenAIStreamContextOverflow({ type: "error", error: overflow })).toBeUndefined();
  expect(readOpenAIStreamContextOverflow({ type: "response.failed", response: { status: "failed", error: overflow } })).toBeUndefined();
});

test("HTTP classification uses structured code and preserves independence from message", () => {
  expect(readOptedInHttpOverflow(400, JSON.stringify({ error: overflow }))).toBe(PROVIDER_CONTEXT_OVERFLOW);
  expect(readOptedInHttpOverflow(400, JSON.stringify({ error: { ...overflow, message: "arbitrary private text" } })))
    .toBe(PROVIDER_CONTEXT_OVERFLOW);
});

test.each([401, 403, 404, 429, 500, 200])("HTTP %s never becomes a capacity rejection", (status) => {
  expect(readOptedInHttpOverflow(status, JSON.stringify({ error: overflow }))).toBeUndefined();
});

test.each([
  "context_length_exceeded",
  JSON.stringify({ error: "context_length_exceeded" }),
  JSON.stringify({ error: { message: JSON.stringify(overflow) } }),
  JSON.stringify({ code: "context_length_exceeded" }),
  JSON.stringify({ error: { ...overflow, code: "invalid_api_key" } }),
  JSON.stringify({ error: { ...overflow, type: "authentication_error" } }),
  JSON.stringify({ contextOverflow: PROVIDER_CONTEXT_OVERFLOW }),
])("HTTP error text and lookalike metadata are not classified: %s", (body) => {
  expect(readOptedInHttpOverflow(400, body)).toBeUndefined();
});

test.each([
  { type: "error", code: overflow.code, message: overflow.message },
  { type: "error", error: overflow },
  { type: "response.failed", response: { status: "failed", error: overflow } },
])("explicit structured stream overflow is classified: %j", (event) => {
  expect(readOptedInStreamOverflow(event)).toBe(PROVIDER_CONTEXT_OVERFLOW);
});

test.each([
  { type: "error", error: "context_length_exceeded" },
  { type: "error", message: JSON.stringify(overflow) },
  { type: "error", code: "invalid_api_key", error: overflow },
  { type: "response.failed", response: { status: "failed", error: { message: "context_length_exceeded" } } },
  { type: "response.failed", response: { status: "completed", error: overflow } },
  { type: "response.failed", response: { error: overflow } },
  { type: "response.completed", response: { status: "completed", error: overflow } },
  { type: "response.output_text.delta", delta: JSON.stringify(overflow) },
  { type: "error", contextOverflow: PROVIDER_CONTEXT_OVERFLOW },
])("stream text, other failures and completed output cannot establish overflow: %j", (event) => {
  expect(readOptedInStreamOverflow(event)).toBeUndefined();
});
