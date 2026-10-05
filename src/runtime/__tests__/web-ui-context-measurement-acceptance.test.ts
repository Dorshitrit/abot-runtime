import { describe, expect, test } from "vitest";
import { buildConversationActivityModel } from "../../web-ui/app/components/conversation-activity.js";
import { createComposerContextWindow } from "../../web-ui/app/components/composer-context-window.js";
import { createComposerContextDom } from "./support/composer-context-window-dom.js";
import {
  contextSnapshotEvent,
  createScopedContextHarness,
} from "./support/context-evidence-fixture.js";

function display(harness: ReturnType<typeof createScopedContextHarness>) {
  return buildConversationActivityModel({
    requestId: "request-1",
    contextWindow: harness.current(),
  }).contextWindow;
}

describe("context measurement acceptance", () => {
  test("A1 renders the measured numerator, ratio and accessible exact count together", () => {
    const harness = createScopedContextHarness();
    harness.send(contextSnapshotEvent());
    const model = display(harness)!;
    expect(model).toMatchObject({
      inputTokens: 21292,
      measurementKind: "actual",
      usedContextPercent: 66.5,
      remainingContextPercent: 33.5,
      remainingContextTokens: 10708,
    });
    const dom = createComposerContextDom();
    const indicator = createComposerContextWindow({
      container: dom.container as unknown as HTMLElement,
      documentRoot: dom.documentRoot as unknown as Document,
    });
    indicator.render(model);
    expect(dom.container.textContent).toContain(
      "21.3K / 32K actual input tokens",
    );
    expect(dom.container.textContent).not.toContain("52.4K");
    const button = dom.container.querySelector(
      ".composer-context-window-button",
    )!;
    expect(button.getAttribute("aria-label")).toContain(
      "21,292 / 32,000 actual input tokens",
    );
    expect(button.getAttribute("aria-label")).toContain("66.5%");
  });

  test("A2 measured zero takes precedence over a positive estimate", () => {
    const harness = createScopedContextHarness();
    harness.send(contextSnapshotEvent({ measuredInputTokens: 0 }));
    expect(display(harness)).toMatchObject({
      inputTokens: 0,
      measurementKind: "actual",
      usedContextPercent: 0,
      remainingContextPercent: 100,
    });
  });

  test.each([
    null,
    undefined,
    NaN,
    Infinity,
    "123",
    "",
    true,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    "A3 rejects malformed measured count %s without numeric coercion",
    (value) => {
      const harness = createScopedContextHarness();
      harness.send(
        contextSnapshotEvent({
          measuredInputTokens: value,
          estimatedInputTokens: 3200,
        }),
      );
      expect(display(harness)).toMatchObject({
        inputTokens: 3200,
        measurementKind: "estimated",
        usedContextPercent: 10,
      });
      harness.send(
        contextSnapshotEvent({
          eventSequence: 11,
          measuredInputTokens: value,
          estimatedInputTokens: value,
        }),
      );
      expect(display(harness)).toBeNull();
    },
  );

  test("A4 hides a newer unavailable measurement including tooltip and ARIA until newer valid evidence", () => {
    const harness = createScopedContextHarness();
    const dom = createComposerContextDom();
    const indicator = createComposerContextWindow({
      container: dom.container as unknown as HTMLElement,
      documentRoot: dom.documentRoot as unknown as Document,
    });
    harness.send(contextSnapshotEvent());
    indicator.render(display(harness));
    const button = dom.container.querySelector(
      ".composer-context-window-button",
    )!;
    button.dispatch("focus");
    harness.send(
      contextSnapshotEvent({
        eventSequence: 12,
        invocationId: "bad",
        modelStep: "worker.decision",
        contextWindowTokens: null,
      }),
    );
    indicator.render(display(harness));
    expect(dom.container.hidden).toBe(true);
    expect(dom.container.textContent).not.toContain("21.3K");
    expect(button.getAttribute("aria-label")).not.toContain("66.5");
    expect(harness.current()?.latestSnapshotObservation).toMatchObject({
      availability: "unavailable",
      invocationId: "bad",
      measurement: null,
    });
    expect(harness.current()?.lastValidSnapshot?.invocationId).toBe(
      "invocation-1",
    );
    harness.send(contextSnapshotEvent({ eventSequence: 11 }));
    expect(display(harness)).toBeNull();
    harness.send(
      contextSnapshotEvent({ eventSequence: 13, measuredInputTokens: 16000 }),
    );
    indicator.render(display(harness));
    expect(dom.container.hidden).toBe(false);
    expect(dom.container.querySelector(".composer-context-window-button")).toBe(
      button,
    );
    expect(button.getAttribute("aria-label")).toContain("50%");
  });

  test("A5 legacy estimates and contradictory metadata never reconstruct from supplied percent", () => {
    const harness = createScopedContextHarness();
    harness.send(
      contextSnapshotEvent({
        measuredInputTokens: undefined,
        estimatedInputTokens: 3200,
        measurement: "actual",
        source: "provider_input_token_count",
        usedContextPercent: 99,
      }),
    );
    expect(display(harness)).toMatchObject({
      inputTokens: 3200,
      measurementKind: "estimated",
      source: "runtime_token_estimator",
      usedContextPercent: 10,
      metadataMismatch: true,
    });
  });

  test("A6 capacity changes and reserves keep a single physical denominator and clamp only the ring", () => {
    const harness = createScopedContextHarness();
    harness.send(
      contextSnapshotEvent({
        contextWindowTokens: 120000,
        measuredInputTokens: 48000,
      }),
    );
    expect(display(harness)?.usedContextPercent).toBe(40);
    harness.send(
      contextSnapshotEvent({
        eventSequence: 11,
        contextWindowTokens: 32000,
        measuredInputTokens: 48000,
        outputReserveTokens: 8000,
        admissionOutcome: "rejected",
      }),
    );
    expect(display(harness)).toMatchObject({
      usedContextPercent: 150,
      remainingContextPercent: 0,
      remainingContextTokens: 0,
    });
    const dom = createComposerContextDom();
    createComposerContextWindow({
      container: dom.container as unknown as HTMLElement,
      documentRoot: dom.documentRoot as unknown as Document,
    }).render(display(harness));
    expect(dom.container.textContent).toContain("150%");
    expect(
      dom.container
        .querySelector(".composer-context-window-ring")
        ?.style.getPropertyValue("--context-used"),
    ).toBe("100%");
  });

  test("A7 keeps usage per invocation, including usage before snapshot and independent optional counts", () => {
    const harness = createScopedContextHarness();
    harness.send({
      name: "context.window.provider_usage",
      type: "event",
      requestId: "request-1",
      invocationId: "B",
      eventSequence: 21,
      inputTokens: 0,
      outputTokens: null,
    });
    harness.send(
      contextSnapshotEvent({ invocationId: "B", eventSequence: 20 }),
    );
    harness.send({
      name: "context.window.provider_usage",
      type: "event",
      requestId: "request-1",
      invocationId: "A",
      eventSequence: 19,
      inputTokens: 8000,
    });
    expect(display(harness)?.providerUsage).toMatchObject({
      invocationId: "B",
      inputTokens: 0,
    });
    expect(display(harness)?.providerUsage?.outputTokens).toBeUndefined();
    expect(display(harness)?.providerUsage?.totalTokens).toBeUndefined();
    harness.send(contextSnapshotEvent({ eventSequence: 22, invocationId: "" }));
    harness.send({
      name: "context.window.provider_usage",
      type: "event",
      requestId: "request-1",
      invocationId: "",
      eventSequence: 23,
      inputTokens: 10,
    });
    expect(display(harness)?.providerUsage).toBeNull();
    harness.send(
      contextSnapshotEvent({
        eventSequence: 24,
        invocationId: "A",
        profileId: "different",
      }),
    );
    harness.send({
      name: "context.window.provider_usage",
      type: "event",
      requestId: "request-1",
      invocationId: "A",
      eventSequence: 25,
      profileId: "luna",
      inputTokens: 2,
    });
    expect(display(harness)?.providerUsage).toBeNull();
  });

  test("A8 selects complete latest attempts through root, controls, compact, child, payload and response", () => {
    const harness = createScopedContextHarness();
    const steps = [
      "execution.decision",
      "capability.controls",
      "context.compact",
      "worker.decision",
      "tool_payload.raw",
      "execution.response",
    ];
    steps.forEach((modelStep, index) => {
      harness.send(
        contextSnapshotEvent({
          eventSequence: index + 10,
          modelStep,
          invocationId: `attempt-${index}`,
          profileId: `profile-${index}`,
          measuredInputTokens: (index + 1) * 100,
          contextWindowTokens: (index + 1) * 1000,
        }),
      );
      expect(display(harness)).toMatchObject({
        modelStep,
        profileId: `profile-${index}`,
        inputTokens: (index + 1) * 100,
        contextWindowTokens: (index + 1) * 1000,
        usedContextPercent: 10,
      });
    });
  });
});
