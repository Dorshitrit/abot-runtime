import { afterEach, expect, test, vi } from "vitest";
import { ModelGatewayInvocationError } from "./invocation-error.js";
import { invokeModelGatewayWithOptions } from "./chat.js";
import { invokeRawModelGatewayWithOptions } from "./raw.js";
import { attachModelGatewayHttpUserMessage, readModelGatewayUserMessage } from "./user-message.js";
import { encodeProviderUserError, PROVIDER_USER_ERROR_HEADER } from "../protocol/provider-user-error.js";

vi.mock("../../runtime/observability/debug-logger.js", () => ({ traceDebug: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

test.each(["network", "http", "stream", "inactivity", "missing_stream"] as const)(
  "%s has deterministic presentation without diagnostic content",
  (kind) => {
    const cause = new Error("SECRET");
    const error = new ModelGatewayInvocationError(kind, "PRIVATE_DIAGNOSTIC", { cause });
    expect(error).toMatchObject({ kind, message: "PRIVATE_DIAGNOSTIC", cause });
    expect(readModelGatewayUserMessage(error)).toBeTruthy();
    expect(readModelGatewayUserMessage(error)).not.toMatch(/PRIVATE|SECRET|Ollama/u);
    expect(readModelGatewayUserMessage(cause)).toBeUndefined();
  },
);

test("only allowlisted bounded provider metadata enters presentation", () => {
  for (const header of [
    "SECRET", JSON.stringify({ kind: "model_provider_user_error_v1", code: "unknown", message: "SECRET" }),
    "x".repeat(4_097), "%invalid-percent-encoding",
  ]) {
    const error = attachModelGatewayHttpUserMessage(new Error("diagnostic"), 500, header, true);
    expect(readModelGatewayUserMessage(error)).toBe(
      "The model service could not complete the request (HTTP 500). Check the model connection and configuration.",
    );
  }
});

test("credentials, query data, arbitrary fields and unsafe model commands cannot enter the explanation", () => {
  const header = encodeURIComponent(JSON.stringify({
    kind: "model_provider_user_error_v1", code: "ollama_model_not_found",
    endpoint: "https://user:SECRET@example.test/path?key=SECRET",
    model: "model; echo SECRET", message: "SECRET",
  }));
  const error = attachModelGatewayHttpUserMessage(new Error("diagnostic"), 404, header, true);
  expect(readModelGatewayUserMessage(error)).toBe(
    "The selected model isn't installed in Ollama at https://example.test. Install the model on the machine running Ollama, then try again.",
  );
});

test.each(["chat", "raw"] as const)("%s keeps tool-media error content suppressed", async (endpoint) => {
  const header = encodeProviderUserError({
    code: "ollama_model_not_found", endpoint: "http://ollama.test", model: "private-model",
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("provider diagnostic", {
    status: 404, headers: { [PROVIDER_USER_ERROR_HEADER]: header! },
  })));
  const privateText = '{"kind":"tool_image_v1","id":"PRIVATE_EVIDENCE"}';
  const common = { agentMode: "reasoning" as const, abortSignal: new AbortController().signal };
  const invocation = endpoint === "chat"
    ? invokeModelGatewayWithOptions({
      ...common, messages: [{ role: "user", content: privateText }], modelStep: "worker.evidence",
    }, { baseUrl: "http://gateway.test" })
    : invokeRawModelGatewayWithOptions({ ...common, prompt: privateText }, { baseUrl: "http://gateway.test" });
  const error = await invocation.catch((value: Error) => value);
  expect(String(error)).not.toContain("private-model");
  expect(readModelGatewayUserMessage(error)).not.toMatch(/private-model|Ollama|PRIVATE_EVIDENCE/u);
});

test("gateway presentation metadata is ASCII and bounds encoded as well as decoded content", () => {
  const header = encodeProviderUserError({
    code: "ollama_unreachable", endpoint: "https://מקומי.example/path?secret=סוד",
  });
  expect(header).toMatch(/^[\x20-\x7e]+$/u);
  const error = attachModelGatewayHttpUserMessage(new Error("diagnostic"), 500, header, true);
  expect(readModelGatewayUserMessage(error)).toContain("https://xn--");
  expect(readModelGatewayUserMessage(error)).not.toMatch(/path|secret|סוד/u);
  const oversized = encodeURIComponent(JSON.stringify({
    kind: "model_provider_user_error_v1", code: "ollama_unreachable", ignored: "x".repeat(2_048),
  }));
  const bounded = attachModelGatewayHttpUserMessage(new Error("diagnostic"), 500, oversized, true);
  expect(readModelGatewayUserMessage(bounded)).not.toContain("Ollama");
});

test("raw network errors retain their original identity and receive a generic gateway explanation", async () => {
  const failure = new TypeError("PRIVATE_FETCH_DETAIL");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
  const error = await invokeRawModelGatewayWithOptions({
    agentMode: "reasoning", prompt: "Write the result.", abortSignal: new AbortController().signal,
  }, { baseUrl: "http://gateway.test" }).catch((value: unknown) => value);
  expect(error).toBe(failure);
  expect(error).not.toBeInstanceOf(ModelGatewayInvocationError);
  expect(readModelGatewayUserMessage(error)).toBe(
    "Can't reach the model gateway. Check that ABot is running and that the model gateway address is correct.",
  );
});

test.each(["chat", "raw"] as const)("%s cancellation preserves identity without attaching a failure explanation", async (endpoint) => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(reason); throw reason; }));
  const common = { agentMode: "reasoning" as const, abortSignal: controller.signal };
  const call = endpoint === "chat"
    ? invokeModelGatewayWithOptions({ ...common, text: "request" }, { baseUrl: "http://gateway.test" })
    : invokeRawModelGatewayWithOptions({ ...common, prompt: "request" }, { baseUrl: "http://gateway.test" });
  const error = await call.catch((value: unknown) => value);
  expect(error).toBe(reason);
  expect(readModelGatewayUserMessage(error)).toBeUndefined();
});
