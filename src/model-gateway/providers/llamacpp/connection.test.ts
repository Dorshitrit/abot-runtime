import { afterEach, describe, expect, test, vi } from "vitest";
import { inspectLlamaCppConnection } from "./connection.js";
import { resolveLlamaCppProviderSettings, resolveLlamaCppUrls } from "./settings.js";

afterEach(() => vi.unstubAllEnvs());
describe("llama.cpp settings and inspection", () => {
  test("accepts an explicit origin or /v1 API root without a credential requirement", () => {
    expect(resolveLlamaCppUrls("http://localhost:8080/")).toEqual({ apiUrl: "http://localhost:8080/v1", serverUrl: "http://localhost:8080" });
    expect(resolveLlamaCppUrls("http://localhost:8080/v1/")).toEqual({ apiUrl: "http://localhost:8080/v1", serverUrl: "http://localhost:8080" });
    expect(resolveLlamaCppProviderSettings({ type: "llamacpp", baseUrl: "http://localhost:8080" }).headers)
      .toEqual({ "Content-Type": "application/json" });
  });
  test("never falls back to an OpenAI key and rejects an explicitly missing key", () => {
    vi.stubEnv("OPENAI_API_KEY", "unrelated");
    vi.stubEnv("LLAMACPP_TEST_KEY", "");
    expect(() => resolveLlamaCppProviderSettings({ type: "llamacpp", baseUrl: "http://localhost:8080", apiKeyEnv: "LLAMACPP_TEST_KEY" }))
      .toThrow("missing llama.cpp API key env: LLAMACPP_TEST_KEY");
    vi.stubEnv("LLAMACPP_TEST_KEY", "local-only");
    expect(resolveLlamaCppProviderSettings({ type: "llamacpp", baseUrl: "http://localhost:8080", apiKeyEnv: "LLAMACPP_TEST_KEY" }).headers.Authorization)
      .toBe("Bearer local-only");
  });
  test.each(["file:///tmp/x", "http://secret@example.test", "https://example.test?apiKey=x"])("rejects unsafe base URL %s", (url) => {
    expect(() => resolveLlamaCppUrls(url)).toThrow("llamacpp_base_url_invalid");
  });
  test("reads only health/models with optional credentials and never infers capabilities", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: "ok" }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "model-a", meta: { n_ctx_train: 99999 } }, { id: "model-a" }] }));
    expect(await inspectLlamaCppConnection({ baseUrl: "http://localhost:8080/v1", apiKey: "fake-only", fetchImpl }))
      .toEqual({ models: ["model-a"] });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(["http://localhost:8080/health", "http://localhost:8080/v1/models"]);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === undefined && init?.body === undefined)).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "application/json", Authorization: "Bearer fake-only" });
  });
  test("does not query models when health says loading", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "loading model" }, { status: 503 }));
    await expect(inspectLlamaCppConnection({ baseUrl: "http://localhost:8080", fetchImpl })).rejects.toThrow("llamacpp_connection_http_503");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  test("bounds response data and does not expose network errors", async () => {
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(256 * 1024 + 1)));
    await expect(inspectLlamaCppConnection({ baseUrl: "http://localhost:8080", fetchImpl: oversized })).rejects.toThrow("llamacpp_connection_response_too_large");
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new Error("private key or URL"));
    await expect(inspectLlamaCppConnection({ baseUrl: "http://localhost:8080", fetchImpl: failed })).rejects.toThrow("llamacpp_connection_failed");
  });
  test("propagates explicit cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(controller.signal.reason);
    await expect(inspectLlamaCppConnection({ baseUrl: "http://localhost:8080", fetchImpl, signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});
