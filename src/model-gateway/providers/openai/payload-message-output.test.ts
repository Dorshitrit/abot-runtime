import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveModelInvocation } from "../../policy/invocation-policy.js";
import type { ModelGatewayEvent, ModelGatewayRequest } from "../../types.js";
import { traceModelIo } from "../../observability/trace-store.js";
import { createOpenAIProviderAdapter } from "./adapter.js";

const tracing = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../observability/trace-store.js", () => ({
  isModelIoTraceEnabled: () => tracing.enabled,
  traceModelIo: vi.fn(async () => {}),
}));

const request: ModelGatewayRequest = {
  modelStep: "tool_payload.raw",
  modelPolicy: {
    providers: { test: { type: "openai", apiKeyEnv: "PAYLOAD_MESSAGE_TEST_KEY" } },
    profiles: { test: { provider: "test", model: "fixture", contextWindowTokens: 32768 } },
    defaults: { profileId: "test" },
  },
};
const products = JSON.stringify(Array.from({ length: 8 }, (_, id) => ({ id, name: `Product ${id}` })));
const draft = `${products}\n*** End Patch`;
function item(index: number, phase?: string) {
  return { type: "response.output_item.added", output_index: index,
    item: { type: "message", id: `message-${index}`, phase } };
}
function delta(index: number, text: string) {
  return { type: "response.output_text.delta", item_id: `message-${index}`, output_index: index, delta: text };
}
const completed = { type: "response.completed", response: {} };
function phases(final = products) {
  return [item(0, "commentary"), delta(0, draft), item(1, "final_answer"), delta(1, final), completed];
}

async function invoke(endpoint: "chat" | "raw", events: unknown[], modelStep = "tool_payload.raw") {
  vi.stubEnv("PAYLOAD_MESSAGE_TEST_KEY", "fixture-only");
  const requestBody = { ...request, modelStep };
  const body = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const result = await createOpenAIProviderAdapter().invoke({
    endpoint, requestBody, invocation: resolveModelInvocation(requestBody),
    fetchImpl: async (_url, init) => {
      // Plain content authoring must stay plain on the provider wire.
      expect(JSON.parse(String(init?.body)).text?.format).toBeUndefined();
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  if (result.kind === "raw") {
    if (typeof result.body.text !== "string") throw new Error("Missing raw payload text");
    return { text: result.body.text };
  }
  if (result.kind !== "chat") throw new Error(result.message);
  const forwarded: ModelGatewayEvent[] = [];
  await result.stream({ emit: (event) => forwarded.push(event) });
  const error = forwarded.find((event) => event.type === "error");
  if (error?.type === "error") throw new Error(String(error.error));
  return { text: forwarded.flatMap((event) => event.type === "content" ? [event.text] : []).join("") };
}

afterEach(() => { tracing.enabled = false; vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe.each(["chat", "raw"] as const)("OpenAI plain payloads over %s", (endpoint) => {
  test("passes only final JSON to the file payload consumer", async () => {
    const result = await invoke(endpoint, phases());
    expect(result.text).toBe(products);
    expect(JSON.parse(result.text)).toHaveLength(8);
  });

  test.each(["<html>שלום</html>\n", "// commentary is part of this file\nconst final_answer = 1;\n"])(
    "preserves exact final content without guessing from syntax: %s", async (text) => {
      expect((await invoke(endpoint, phases(text))).text).toBe(text);
    },
  );

  test("resolves phases supplied only with the terminal response", async () => {
    const events = [delta(0, draft), delta(1, products), {
      type: "response.completed", response: { output: [item(0, "commentary").item, item(1, "final_answer").item] },
    }];
    expect((await invoke(endpoint, events)).text).toBe(products);
  });

  test("keeps the first text message for responses without phase metadata", async () => {
    expect((await invoke(endpoint, [item(0), delta(0, products), item(1), delta(1, "extra"), completed])).text)
      .toBe(products);
  });

  test("keeps legacy unidentified text chunks intact", async () => {
    const events = ["hello ", "world"].map((text) => ({ type: "response.output_text.delta", delta: text }));
    expect((await invoke(endpoint, [...events, completed])).text).toBe("hello world");
  });

  test("does not hand commentary-only output to the payload consumer", async () => {
    await expect(invoke(endpoint, [item(0, "commentary"), delta(0, products), completed]))
      .rejects.toThrow("missing final_answer");
  });

  test("preserves invalid final content for the existing file validator", async () => {
    expect((await invoke(endpoint, phases("not JSON"))).text).toBe("not JSON");
  });

  test("propagates provider failure instead of accepting the draft", async () => {
    await expect(invoke(endpoint, [item(0, "commentary"), delta(0, draft),
      { type: "error", error: { message: "provider failure" } }])).rejects.toThrow("provider failure");
  });

  test.each(["supervisor.response", "execution.response", "custom.text"])(
    "leaves ordinary text streaming for %s unchanged", async (modelStep) => {
      expect((await invoke(endpoint, phases(), modelStep)).text).toBe(draft + products);
    },
  );

  test("retains both provider messages in raw tracing while selecting the final payload", async () => {
    tracing.enabled = true;
    expect((await invoke(endpoint, phases())).text).toBe(products);
    expect(traceModelIo).toHaveBeenLastCalledWith(expect.objectContaining({
      event: "provider.response", response: expect.objectContaining({
        body: phases().map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
        decoded: expect.objectContaining({ text: draft + products }),
      }),
    }));
  });
});
