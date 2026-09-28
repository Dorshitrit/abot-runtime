import { afterEach, expect, test, vi } from "vitest";
import { invokeModelGatewayWithOptions } from "./chat.js";
import { traceDebug } from "../../runtime/observability/debug-logger.js";

vi.mock("../../runtime/observability/debug-logger.js", () => ({
  traceDebug: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test.each(["learning.batch", "supervisor.decision"] as const)(
  "provider error logging respects %s content policy",
  async (modelStep) => {
    const body = "Private screen content echoed by provider";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 500 })),
    );
    const error = await invokeModelGatewayWithOptions(
      {
        modelStep,
        agentMode: "fast",
        text: "request",
        abortSignal: new AbortController().signal,
      },
      { baseUrl: "http://gateway.test" },
    ).catch((value: Error) => value);
    const call = vi
      .mocked(traceDebug)
      .mock.calls.find((args) => args[1] === "chat.response.error");
    expect(call?.[2]).toMatchObject({ status: 500, bodyLength: body.length });
    if (modelStep === "learning.batch") {
      expect(JSON.stringify(call)).not.toContain(body);
      expect(String(error)).not.toContain(body);
    } else {
      expect(call?.[2]).toMatchObject({ bodyPreview: body });
    }
  },
);
