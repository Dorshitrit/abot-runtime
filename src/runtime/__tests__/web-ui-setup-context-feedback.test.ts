import { describe, expect, test, vi } from "vitest";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import type { RuntimeSetupResponse } from "../../web-ui/app/components/runtime-setup-guide.js";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";

function contextRejection(contextWindow = {}) {
  return {
    ok: false,
    error: "context_window_too_small",
    message: "private-server-exception /private/config synthetic-secret",
    contextWindow: {
      field: "contextWindowTokens",
      declaredTokens: 4096,
      effectiveTokens: 4096,
      reservedTokens: 9000,
      minimumTokens: 9001,
      ...contextWindow,
    },
  };
}

function clientHarness(payload = contextRejection(), status = 400) {
  const saved = {
    setup: setupSnapshot,
    activation: { status: "restart_required" },
  };
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status }))
    .mockImplementation(async () => new Response(JSON.stringify(saved)));
  const client = createRuntimeWebClient({
    getConfig: () => null,
    getEnvironmentId: () => "test",
    origin: "http://localhost",
    fetchImpl,
  });
  const harness = createGuideHarness({
    saveSetup: (input) =>
      client.saveRuntimeSetup(input) as Promise<RuntimeSetupResponse>,
  });
  return { ...harness, fetchImpl };
}

async function submitRejectedConnection(
  harness: ReturnType<typeof clientHarness>,
  contextWindow = "4096",
) {
  await harness.open();
  harness.changeProvider("ollama");
  harness.submit();
  harness.inputModel("configured-model");
  harness.inputContextWindow(contextWindow);
  harness.submit();
  await harness.ready();
}

function contextMarkup(harness: ReturnType<typeof clientHarness>) {
  return harness.container.innerHTML.match(
    /<input[^>]+data-runtime-setup-field="context-window"[^>]*>/,
  )?.[0];
}

function inlineFeedback(harness: ReturnType<typeof clientHarness>) {
  return harness.container.innerHTML.match(
    /<small id="runtimeSetupError-context-window"[^>]*>([^<]*)<\/small>/,
  )?.[1];
}

describe("onboarding context constraint feedback", () => {
  test("carries a runtime-client HTTP rejection into the field and retries a corrected candidate", async () => {
    const harness = clientHarness();
    await submitRejectedConnection(harness);
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(contextMarkup(harness)).toContain('value="4096"');
    expect(contextMarkup(harness)).toContain('min="9001"');
    expect(contextMarkup(harness)).toContain('aria-invalid="true"');
    expect(contextMarkup(harness)).toContain(
      'aria-describedby="runtimeSetupHelp-context-window runtimeSetupError-context-window"',
    );
    expect(inlineFeedback(harness)).toContain("4,096");
    expect(inlineFeedback(harness)).toContain("9,000");
    expect(inlineFeedback(harness)).toContain("9,001");
    expect(harness.container.innerHTML).not.toContain(
      "private-server-exception",
    );
    expect(harness.container.innerHTML).not.toContain("synthetic-secret");
    expect(harness.fields["context-window"].focus).toHaveBeenCalled();
    const focusOrder =
      harness.fields["context-window"].focus.mock.invocationCallOrder;
    const titleOrder = harness.title.focus.mock.invocationCallOrder;
    expect(focusOrder.at(-1)).toBeGreaterThan(titleOrder.at(-1)!);

    harness.inputContextWindow("10000");
    expect(inlineFeedback(harness)).toBeUndefined();
    expect(
      harness.fields["context-window"].removeAttribute,
    ).toHaveBeenCalledWith("aria-invalid");
    expect(harness.fields["context-window"].setAttribute).toHaveBeenCalledWith(
      "min",
      "1",
    );
    harness.submit();
    await harness.ready();
    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(harness.fetchImpl.mock.calls[1][1]?.body)),
    ).toMatchObject({ contextWindowTokens: 10000, deferActivation: true });
    expect(harness.loadEmbeddingStatus).toHaveBeenCalledOnce();
    expect(harness.applySetup).not.toHaveBeenCalled();
    expect(inlineFeedback(harness)).toBeUndefined();
  });

  test("explains an allocation cap that cannot be fixed by raising the declaration alone", async () => {
    const harness = clientHarness(
      contextRejection({
        declaredTokens: 16000,
        effectiveTokens: 7000,
        allocationTokens: 7000,
        reservedTokens: 12000,
        minimumTokens: 12001,
        environmentId: "private-environment-name",
      }),
    );
    await submitRejectedConnection(harness, "16000");
    expect(contextMarkup(harness)).toContain('min="12001"');
    expect(inlineFeedback(harness)).toContain("12,001");
    expect(inlineFeedback(harness)).toContain("7,000");
    expect(inlineFeedback(harness)).toMatch(/num_ctx/);
    expect(harness.container.innerHTML).not.toContain(
      "private-environment-name",
    );
    expect(harness.container.innerHTML).not.toContain(
      "private-server-exception",
    );
  });

  test.each([
    ["model", "inputModel", "another-model"],
    ["context", "inputContextWindow", "8192"],
    ["address", "inputBaseUrl", "http://192.0.2.10:11434"],
    ["credential", "inputKey", "replacement-secret"],
  ] as const)(
    "clears candidate feedback when the %s changes",
    async (_, method, value) => {
      const harness = clientHarness();
      await submitRejectedConnection(harness);
      expect(inlineFeedback(harness)).toBeDefined();
      harness[method](value);
      expect(inlineFeedback(harness)).toBeUndefined();
      expect(
        harness.fields["context-window"].setAttribute,
      ).toHaveBeenCalledWith(
        "aria-describedby",
        "runtimeSetupHelp-context-window",
      );
      harness.submit();
      await harness.ready();
      expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
      expect(harness.loadEmbeddingStatus).toHaveBeenCalledOnce();
    },
  );

  test("drops the old bound when returning to provider selection", async () => {
    const harness = clientHarness();
    await submitRejectedConnection(harness);
    harness.click("back");
    harness.changeProvider("openai");
    harness.submit();
    expect(contextMarkup(harness)).toContain('min="1"');
    expect(contextMarkup(harness)).not.toContain("aria-invalid");
    expect(inlineFeedback(harness)).toBeUndefined();
    expect(harness.fields["context-window"].value).toBe("4096");
  });

  test("does not move focus back into the form when focus moved outside", async () => {
    const harness = clientHarness();
    let completeResponse!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      completeResponse = resolve;
    });
    harness.fetchImpl.mockReset().mockReturnValueOnce(pending);
    await harness.open();
    harness.changeProvider("ollama");
    harness.submit();
    harness.inputModel("configured-model");
    harness.inputContextWindow("4096");
    const inside = harness.fields["context-window"];
    const document = {
      activeElement: inside as unknown,
      body: {},
      documentElement: {},
    };
    Object.assign(harness.container, {
      ownerDocument: document,
      contains: (element: unknown) => element === inside,
    });
    harness.submit();
    document.activeElement = { id: "outside" };
    completeResponse(
      new Response(JSON.stringify(contextRejection()), { status: 400 }),
    );
    await harness.ready();
    expect(contextMarkup(harness)).toContain('aria-invalid="true"');
    expect(harness.fields["context-window"].focus).not.toHaveBeenCalled();
  });

  test.each([
    [
      "unknown code",
      { ...contextRejection(), error: "runtime_setup_failed" },
      400,
    ],
    ["wrong status", contextRejection(), 500],
    ["wrong field", contextRejection({ field: "apiKey" }), 400],
    ["non-numeric bound", contextRejection({ minimumTokens: "secret" }), 400],
    ["non-integer bound", contextRejection({ minimumTokens: 9001.5 }), 400],
    [
      "invalid effective capacity",
      contextRejection({ effectiveTokens: 10000 }),
      400,
    ],
    ["invalid allocation", contextRejection({ allocationTokens: -1 }), 400],
  ])(
    "sanitizes %s without showing raw exception details",
    async (_, payload, status) => {
      const harness = clientHarness(
        payload as ReturnType<typeof contextRejection>,
        status as number,
      );
      await submitRejectedConnection(harness);
      expect(harness.container.innerHTML).toContain('id="runtimeSetupError"');
      expect(inlineFeedback(harness)).toBeUndefined();
      expect(contextMarkup(harness)).toContain('min="1"');
      expect(contextMarkup(harness)).not.toContain("aria-invalid");
      expect(harness.container.innerHTML).not.toContain(
        "private-server-exception",
      );
      expect(harness.container.innerHTML).not.toContain("/private/config");
      expect(harness.container.innerHTML).not.toContain("synthetic-secret");
    },
  );
});
