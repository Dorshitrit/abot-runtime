import { afterEach, expect, test, vi } from "vitest";
import { ChatGptAuthError } from "../../../provider-auth/chatgpt/contracts.js";
import { createBuiltInModelProviderAdapterRegistry } from "../registry.js";
import { createChatGptProviderAdapter } from "./adapter.js";
import { accountRef, completed, invoke, request, response } from "./__tests__/fixture.js";

afterEach(() => vi.unstubAllEnvs());

test("only uses the selected account and fixed Responses endpoint even with API-key environment configuration", async () => {
  vi.stubEnv("OPENAI_API_KEY", "never-use-this-key");
  vi.stubEnv("OPENAI_BASE_URL", "https://redirect.invalid/v1");
  const getAccessToken = vi.fn(async () => "plan-credential");
  const fetchImpl = vi.fn<typeof fetch>(async () => response([completed]));
  const controller = new AbortController();
  await invoke(fetchImpl, request, "raw", controller.signal, getAccessToken);
  expect(getAccessToken).toHaveBeenCalledExactlyOnceWith(accountRef, controller.signal);
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://api.openai.com/v1/responses", expect.objectContaining({
    method: "POST", signal: controller.signal, redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: "Bearer plan-credential" },
  }));
  const payload = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
  expect(payload).toMatchObject({ stream: true, store: false });
  expect(payload).not.toHaveProperty("temperature");
  expect(payload).not.toHaveProperty("top_p");
});

test("a rejected redirect propagates once without retry or API-key fallback", async () => {
  vi.stubEnv("OPENAI_API_KEY", "never-use-this-key");
  const redirectFailure = new TypeError("fetch failed: unexpected redirect");
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    expect(init?.redirect).toBe("error");
    throw redirectFailure;
  });
  await expect(invoke(fetchImpl)).rejects.toBe(redirectFailure);
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
});

test.each([
  { baseUrl: "https://redirect.invalid" }, { apiKeyEnv: "OPENAI_API_KEY" },
  { settings: { accountRef, baseUrl: "https://redirect.invalid" } },
  { settings: { accountRef: "invalid" } },
])("rejects invalid connection bindings before authentication or transport: %j", async (override) => {
  const getAccessToken = vi.fn(async () => "unused");
  const fetchImpl = vi.fn<typeof fetch>();
  const requestBody = { ...request, modelPolicy: { ...request.modelPolicy!, providers: {
    plan: { type: "openai-chatgpt", settings: { accountRef }, ...override },
  } } };
  await expect(invoke(fetchImpl, requestBody, "raw", undefined, getAccessToken)).resolves.toMatchObject({ kind: "error", statusCode: 400 });
  expect(getAccessToken).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("profile connection overrides are rejected and failed authentication cannot fall back to API billing", async () => {
  const getAccessToken = vi.fn(async () => { throw new ChatGptAuthError("signed_out", "Sign in again.", 401); });
  const fetchImpl = vi.fn<typeof fetch>();
  const modelPolicy = request.modelPolicy!;
  const overridden = { ...request, modelPolicy: { ...modelPolicy, profiles: {
    plan: { ...modelPolicy.profiles!.plan!, options: { baseUrl: "https://redirect.invalid" } },
  } } };
  await expect(invoke(fetchImpl, overridden, "raw", undefined, getAccessToken)).resolves.toMatchObject({ kind: "error", statusCode: 400 });
  expect(getAccessToken).not.toHaveBeenCalled();
  await expect(invoke(fetchImpl, request, "raw", undefined, getAccessToken)).resolves.toEqual({ kind: "error", statusCode: 401, message: "Sign in again." });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each(["before", "during"])("cancellation %s credential acquisition cannot start an inference", async (when) => {
  const controller = new AbortController();
  const cause = new DOMException("request cancelled", "AbortError");
  const fetchImpl = vi.fn<typeof fetch>();
  const getAccessToken = vi.fn(async (_account: string, signal?: AbortSignal) => {
    expect(signal).toBe(controller.signal);
    controller.abort(cause);
    return "credential-after-cancel";
  });
  if (when === "before") controller.abort(cause);
  await expect(invoke(fetchImpl, request, "raw", controller.signal, getAccessToken)).rejects.toBe(cause);
  expect(getAccessToken).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("registry exposes inference only for ChatGPT without embedding or input-token endpoints", () => {
  const adapter = createChatGptProviderAdapter();
  expect(adapter.type).toBe("openai-chatgpt");
  expect(adapter.countInputTokens).toBeUndefined();
  expect(adapter.embed).toBeUndefined();
  expect(adapter.listEmbeddingModels).toBeUndefined();
  const registry = createBuiltInModelProviderAdapterRegistry({ ollamaUrl: "http://localhost:11434" });
  expect(registry.resolve("openai-chatgpt").type).toBe("openai-chatgpt");
  expect(registry.resolve("openai").countInputTokens).toBeTypeOf("function");
  expect(registry.resolve("openai").embed).toBeTypeOf("function");
});
