import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetDebugLoggerConfig } from "../../runtime/observability/debug-logger.js";
import { createContextOverflowFlow } from "./__tests__/support/context-overflow-flow.js";
import {
  isProviderContextOverflowError, PROVIDER_CONTEXT_OVERFLOW, PROVIDER_CONTEXT_OVERFLOW_HEADER,
} from "../protocol/provider-context-overflow.js";
import { completedFunction, frame, preamble } from "../providers/openai/__tests__/native-function-fixture.js";

const overflow = { code: "context_length_exceeded", type: "invalid_request_error", message: "Capacity rejected." };
const failed = { type: "response.failed", response: { status: "failed", error: overflow } };
const providers = ["openai", "openai-chatgpt"] as const;
const endpoints = ["chat", "raw"] as const;
const routes = providers.flatMap((provider) => endpoints.map((endpoint) => ({ provider, endpoint })));
const stream = (events: readonly unknown[]) => new Response(events.map(frame).join(""), {
  headers: { "Content-Type": "text/event-stream" },
});

beforeEach(() => vi.stubEnv("OVERFLOW_FIXTURE_KEY", "test-only-api-key"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetDebugLoggerConfig();
});

test.each(routes)("$provider $endpoint preserves HTTP status/body with ChatGPT-only recovery metadata", async ({ provider, endpoint }) => {
  const body = JSON.stringify({ error: overflow });
  const f = await createContextOverflowFlow(provider, () => new Response(body, {
    status: 400, headers: { [PROVIDER_CONTEXT_OVERFLOW_HEADER]: PROVIDER_CONTEXT_OVERFLOW },
  }));
  try {
    const response = await f.post(endpoint);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(body);
    expect(response.headers.get(PROVIDER_CONTEXT_OVERFLOW_HEADER)).toBe(
      provider === "openai-chatgpt" ? PROVIDER_CONTEXT_OVERFLOW : null);
    const error = await f.invoke(endpoint).catch((cause: unknown) => cause);
    expect(isProviderContextOverflowError(error)).toBe(provider === "openai-chatgpt");
    if (provider === "openai") expect((error as Error).cause).toBeUndefined();
    expect((error as Error).message).toContain(`:400:${body}`);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  } finally { await f.dispose(); }
});

test.each([
  { status: 401, body: JSON.stringify({ error: overflow }) },
  { status: 429, body: JSON.stringify({ error: overflow }) },
  { status: 400, body: JSON.stringify({ error: { code: "invalid_api_key", message: "context_length_exceeded" } }) },
  { status: 400, body: JSON.stringify({ contextOverflow: PROVIDER_CONTEXT_OVERFLOW }) },
  { status: 400, body: "context_length_exceeded" },
])("upstream headers or diagnostic text cannot classify HTTP $status: $body", async ({ status, body }) => {
  const f = await createContextOverflowFlow("openai-chatgpt", () => new Response(body, {
    status, headers: { [PROVIDER_CONTEXT_OVERFLOW_HEADER]: PROVIDER_CONTEXT_OVERFLOW },
  }));
  try {
    for (const endpoint of endpoints) {
      const response = await f.post(endpoint);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(body);
      expect(response.headers.has(PROVIDER_CONTEXT_OVERFLOW_HEADER)).toBe(false);
      const error = await f.invoke(endpoint).catch((cause: unknown) => cause);
      expect(isProviderContextOverflowError(error)).toBe(false);
    }
  } finally { await f.dispose(); }
});

test.each(routes)("$provider $endpoint transports exact failed stream without accepting finalized function items", async ({ provider, endpoint }) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await createContextOverflowFlow(provider, () => stream([...preamble, failed]));
  try {
    const response = await f.post(endpoint);
    const body = await response.text();
    if (endpoint === "chat") {
      expect(response.status).toBe(200);
      const expected = { type: "error", error: overflow.message,
        ...(provider === "openai-chatgpt" ? { contextOverflow: PROVIDER_CONTEXT_OVERFLOW } : {}) };
      expect(body).toBe(JSON.stringify(expected) + "\n");
      expect(body).not.toContain('"type":"done"');
      expect(body).not.toContain('"type":"content"');
    } else {
      expect(response.status).toBe(500);
      expect(body).toBe("server error");
      expect(response.headers.get(PROVIDER_CONTEXT_OVERFLOW_HEADER)).toBe(
        provider === "openai-chatgpt" ? PROVIDER_CONTEXT_OVERFLOW : null);
    }
    const error = await f.invoke(endpoint).catch((cause: unknown) => cause);
    expect(isProviderContextOverflowError(error)).toBe(provider === "openai-chatgpt");
    if (provider === "openai") expect((error as Error).cause).toBeUndefined();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  } finally { await f.dispose(); }
});

test.each(endpoints)("%s completed output ignores a later lookalike overflow event", async (endpoint) => {
  const f = await createContextOverflowFlow("openai-chatgpt", () => stream([completedFunction, failed]));
  try {
    const result = await f.invoke(endpoint);
    expect(result.text).toBe(JSON.stringify({ decision: { path: "שלום/file.txt" } }));
  } finally { await f.dispose(); }
});

test.each(endpoints)("%s malformed or unfinished stream does not become a capacity failure", async (endpoint) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await createContextOverflowFlow("openai-chatgpt", () => stream(preamble));
  try {
    const error = await f.invoke(endpoint).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(isProviderContextOverflowError(error)).toBe(false);
  } finally { await f.dispose(); }
});

test.each(["http", "stream"] as const)("tool-media privacy keeps only typed capacity metadata for %s", async (transport) => {
  const diagnostic = { ...overflow, message: "private tool image URL https://private.invalid/secret" };
  const upstream = transport === "http"
    ? () => new Response(JSON.stringify({ error: diagnostic }), { status: 400 })
    : () => stream([{ type: "response.failed", response: { status: "failed", error: diagnostic } }]);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await createContextOverflowFlow("openai-chatgpt", upstream, JSON.stringify({ kind: "tool_image_v1" }));
  try {
    for (const endpoint of endpoints) {
      const response = await f.post(endpoint);
      const body = await response.text();
      expect(body).not.toContain("private.invalid");
      const error = await f.invoke(endpoint).catch((cause: unknown) => cause);
      expect(isProviderContextOverflowError(error)).toBe(true);
      expect((error as Error).message).not.toContain("private.invalid");
    }
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("private.invalid");
  } finally { await f.dispose(); }
});
