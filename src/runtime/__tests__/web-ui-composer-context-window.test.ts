import { describe, expect, test, vi } from "vitest";

import {
  buildComposerContextWindowModel,
  createComposerContextWindow,
} from "../../web-ui/app/components/composer-context-window.js";
import { createComposerContextDom } from "./support/composer-context-window-dom.js";

function metricRecord(
  requestId: string,
  snapshot: Record<string, unknown> = {},
) {
  return {
    requestId,
    snapshot: {
      invocationId: `invocation-${requestId}`,
      modelStep: "worker.decision",
      profileId: "local",
      measurement: "estimated",
      source: "runtime_token_estimator",
      admissionOutcome: "accepted",
      contextWindowTokens: 10_000,
      estimatedInputTokens: 3_120,
      remainingContextTokens: 6_880,
      usedContextPercent: 31.2,
      remainingContextPercent: 68.8,
      compactionTriggerPercent: 70,
      outputReserveTokens: 1_000,
      safetyReserveTokens: 100,
      attachmentReserveTokens: 50,
      formatReserveTokens: 20,
      ...snapshot,
    },
    providerUsage: {
      invocationId: `invocation-${requestId}`,
      inputTokens: 3_100,
      outputTokens: 84,
      totalTokens: 3_184,
      source: "provider_reported",
    },
    lastCompaction: { beforePercent: 81, afterPercent: 31.2 },
  };
}

function modelFor(
  records: Array<ReturnType<typeof metricRecord>>,
  messages = records.map(({ requestId }) => ({ role: "assistant", requestId })),
  activeRequestId = "",
) {
  const recordsByRequest = new Map(
    records.map((record) => [record.requestId, record]),
  );
  return buildComposerContextWindowModel({
    messages,
    activeRequestId,
    getActivityForMessage: (message) => ({
      contextWindow: recordsByRequest.get(String(message.requestId)),
    }),
  });
}

describe("composer context request selection", () => {
  test("prioritizes a matching active assistant over message or map insertion order", () => {
    const older = metricRecord("older");
    const active = metricRecord("active", { usedContextPercent: 60 });
    const messages = [
      { role: "assistant", requestId: "active" },
      { role: "assistant", requestId: "older" },
      { role: "user", requestId: "unrelated" },
    ];

    expect(modelFor([active, older], messages, "active")).toMatchObject({
      requestId: "active",
      usedContextPercent: 60,
    });
  });

  test("chooses the newest message when it is an assistant and ignores foreign request entries", () => {
    const records = [
      metricRecord("latest"),
      metricRecord("older"),
      metricRecord("foreign"),
    ];
    const messages = [
      { role: "assistant", requestId: "older" },
      { role: "user", requestId: "foreign" },
      { role: "assistant", requestId: "latest" },
    ];

    expect(modelFor(records, messages)).toMatchObject({
      requestId: "latest",
    });
    expect(modelFor(records, messages, "foreign")).toBeNull();
  });

  test("does not revive the previous request after a new local user turn", () => {
    const messages = [
      { role: "assistant", requestId: "completed" },
      { role: "user", requestId: "" },
    ];

    expect(modelFor([metricRecord("completed")], messages)).toBeNull();
  });

  test("does not skip a new assistant without a request ID to reuse older metrics", () => {
    const messages = [
      { role: "assistant", requestId: "completed" },
      { role: "assistant", requestId: "" },
    ];

    expect(modelFor([metricRecord("completed")], messages)).toBeNull();
  });

  test("keeps pending and newly assigned turns empty until their own metrics arrive", () => {
    const records = [metricRecord("completed")];
    const messages = [{ role: "assistant", requestId: "completed" }];
    expect(modelFor(records, messages)?.requestId).toBe("completed");

    messages.push({ role: "user", requestId: "" });
    expect(modelFor(records, messages)).toBeNull();

    messages.push({ role: "assistant", requestId: "new-request" });
    expect(modelFor(records, messages, "new-request")).toBeNull();

    records.push(metricRecord("new-request", { usedContextPercent: 12 }));
    expect(modelFor(records, messages, "new-request")).toMatchObject({
      requestId: "new-request",
      usedContextPercent: 12,
    });
    expect(modelFor(records, messages)?.requestId).toBe("new-request");
  });

  test.each(["", "pending"])(
    "does not show an earlier request when selected request has no snapshot (active=%s)",
    (activeRequestId) => {
      const messages = [
        { role: "assistant", requestId: "older" },
        { role: "assistant", requestId: "pending" },
      ];
      expect(
        modelFor([metricRecord("older")], messages, activeRequestId),
      ).toBeNull();
    },
  );

  test("clears stale session metrics when current-session messages are empty", () => {
    expect(
      modelFor([metricRecord("previous-session")], [], "previous-session"),
    ).toBeNull();
    expect(
      buildComposerContextWindowModel({
        getActivityForMessage: vi.fn(),
      }),
    ).toBeNull();
  });

  test("preserves existing metric values, reserves, compaction, and provider usage", () => {
    const model = modelFor([metricRecord("current")]);
    expect(model).toMatchObject({
      requestId: "current",
      contextWindowTokens: 10_000,
      estimatedInputTokens: 3_120,
      remainingContextTokens: 6_880,
      usedContextPercent: 31.2,
      remainingContextPercent: 68.8,
      compactionTriggerPercent: 70,
      outputReserveTokens: 1_000,
      safetyReserveTokens: 100,
      attachmentReserveTokens: 50,
      formatReserveTokens: 20,
      compaction: { beforePercent: 81, afterPercent: 31.2 },
      providerUsage: {
        inputTokens: 3_100,
        outputTokens: 84,
        totalTokens: 3_184,
      },
    });
  });

  test("rejects mismatched request data and excludes another invocation's provider usage", () => {
    const record = metricRecord("current");
    record.providerUsage.invocationId = "old-invocation";
    expect(modelFor([record])?.providerUsage).toBeNull();
    expect(
      buildComposerContextWindowModel({
        messages: [{ role: "assistant", requestId: "current" }],
        getActivityForMessage: () => ({
          contextWindow: metricRecord("foreign"),
        }),
      }),
    ).toBeNull();
  });

  test.each([
    { contextWindowTokens: 0 },
    { contextWindowTokens: Number.NaN },
    { usedContextPercent: -1 },
    { usedContextPercent: Number.NaN },
  ])("omits invalid context metrics: %j", (snapshot) => {
    expect(modelFor([metricRecord("current", snapshot)])).toBeNull();
  });
});

describe("compact composer context presentation", () => {
  function renderContext() {
    const dom = createComposerContextDom();
    const indicator = createComposerContextWindow({
      container: dom.container as unknown as HTMLElement,
      documentRoot: dom.documentRoot as unknown as Document,
    });
    const model = modelFor([metricRecord("current")])!;
    indicator.render(model);
    return { ...dom, indicator, model };
  }

  test("renders a compact percentage control with an associated detailed tooltip", () => {
    const { container } = renderContext();
    const button = container.querySelector(".composer-context-window-button");
    const tooltip = container.querySelector("#composerContextWindowTooltip");
    const ring = container.querySelector(".composer-context-window-ring");

    expect(container.hidden).toBe(false);
    expect(button?.type).toBe("button");
    expect(button?.getAttribute("aria-label")).toContain("31.2%");
    expect(button?.getAttribute("aria-describedby")).toBe(tooltip?.id);
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(ring?.style.getPropertyValue("--context-used")).toBe("31.2%");
    expect(tooltip?.textContent).toContain("Context window");
    expect(tooltip?.textContent).toContain("31.2%");
    expect(tooltip?.textContent).toContain("68.8%");
    expect(tooltip?.textContent).toContain("3.1K / 10K estimated input tokens");
    expect(tooltip?.textContent).toContain("worker.decision");
    expect(tooltip?.textContent).toContain(
      "Provider reported 3.1K input · 84 output tokens",
    );
    expect(tooltip?.textContent).toContain("Compaction");
    expect(tooltip?.textContent).toContain("81%");
  });

  test("retains the same button while refreshing metrics and bounds only the ring", () => {
    const { container, indicator, model } = renderContext();
    const button = container.querySelector(".composer-context-window-button");
    indicator.render({
      ...model,
      usedContextPercent: 120,
      admissionOutcome: "rejected",
    });

    expect(container.querySelector(".composer-context-window-button")).toBe(
      button,
    );
    expect(button?.getAttribute("aria-label")).toContain("120%");
    expect(
      container
        .querySelector(".composer-context-window-ring")
        ?.style.getPropertyValue("--context-used"),
    ).toBe("100%");
    expect(container.textContent).toContain("120%");
    expect(container.classList.contains("rejected")).toBe(true);
    indicator.render(model);
    expect(container.classList.contains("rejected")).toBe(false);
  });

  test.each(["null", "reset"])(
    "%s clears stale progress and tooltip state",
    (action) => {
      const { container, indicator } = renderContext();
      const button = container.querySelector(".composer-context-window-button");
      button?.dispatch("click");
      if (action === "null") indicator.render(null);
      if (action === "reset") indicator.reset();

      expect(container.hidden).toBe(true);
      expect(container.classList.contains("open")).toBe(false);
      expect(
        container.querySelector("#composerContextWindowTooltip")?.hidden,
      ).toBe(true);
      expect(
        container
          .querySelector(".composer-context-window-ring")
          ?.style.getPropertyValue("--context-used"),
      ).toBe("0%");
      expect(container.textContent).not.toContain("31.2%");
      expect(container.textContent).not.toContain("worker.decision");
      expect(container.querySelector(".composer-context-window-button")).toBe(
        button,
      );
    },
  );

  test("shows details on keyboard focus and lets Escape dismiss them", () => {
    const { container, documentRoot } = renderContext();
    const button = container.querySelector(".composer-context-window-button");
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    button?.dispatch("focus");
    expect(container.classList.contains("open")).toBe(true);
    documentRoot.dispatch("keydown", {
      key: "Escape",
      preventDefault,
      stopPropagation,
    });
    expect(container.classList.contains("open")).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  test("dismisses hover-open details with Escape while focus stays in the composer", () => {
    const { container, documentRoot } = renderContext();
    const composer = documentRoot.createElement("textarea");
    documentRoot.activeElement = composer;
    container.dispatch("pointerenter");
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    documentRoot.dispatch("keydown", {
      key: "Escape",
      target: composer,
      preventDefault,
      stopPropagation,
    });

    expect(container.classList.contains("open")).toBe(false);
    expect(
      container.querySelector("#composerContextWindowTooltip")?.hidden,
    ).toBe(true);
    expect(documentRoot.activeElement).toBe(composer);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  test("does not consume Escape while the tooltip is hidden", () => {
    const { container, documentRoot } = renderContext();
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    documentRoot.dispatch("keydown", {
      key: "Escape",
      preventDefault,
      stopPropagation,
    });

    expect(
      container.querySelector("#composerContextWindowTooltip")?.hidden,
    ).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  test("keeps hover details open while keyboard-focused and closes on blur", () => {
    const { container, documentRoot } = renderContext();
    const button = container.querySelector(".composer-context-window-button");
    const tooltip = container.querySelector("#composerContextWindowTooltip");
    container.dispatch("pointerenter");
    expect(tooltip?.hidden).toBe(false);
    container.dispatch("pointerleave");
    expect(tooltip?.hidden).toBe(true);

    documentRoot.activeElement = button;
    button?.dispatch("focus");
    container.dispatch("pointerleave");
    expect(container.classList.contains("open")).toBe(true);
    documentRoot.activeElement = null;
    button?.dispatch("blur");
    expect(tooltip?.hidden).toBe(true);
  });

  test("opens on touch-style click, preserves inside interaction, and dismisses outside", () => {
    const { container, documentRoot } = renderContext();
    const button = container.querySelector(".composer-context-window-button")!;
    button.dispatch("click");
    expect(container.classList.contains("open")).toBe(true);
    documentRoot.dispatch("pointerdown", { target: button });
    expect(container.classList.contains("open")).toBe(true);
    documentRoot.dispatch("pointerdown", {
      target: documentRoot.createElement("div"),
    });
    expect(container.classList.contains("open")).toBe(false);
    expect(
      container.querySelector("#composerContextWindowTooltip")?.hidden,
    ).toBe(true);
  });
});
