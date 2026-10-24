import { afterEach, expect, test, vi } from "vitest";
import { composerProductFixture, deferred } from "./__tests__/composer-product-fixture.js";

afterEach(() => vi.unstubAllGlobals());

test.each(["cancel", "environment", "draft", "approve"] as const)(
  "paused-message review waits and rechecks %s", async (change) => {
    const approval = deferred<boolean>();
    const confirmReview = vi.fn(() => approval.promise);
    const f = await composerProductFixture({ confirmReview });
    const scope = { environmentId: "prod", sessionId: "chat-1" };
    const draft = f.composer.drafts.open(scope);
    draft.text = "Unconfirmed message";
    const result = await f.composer.lifecycle.submit({ draft, action: "send",
      execute: async () => { throw new Error("Acknowledgement lost"); } });
    expect(result.status).toBe("uncertain");
    const review = f.dom.composerForm.querySelector(".composer-submission-notice")?.querySelector("button");
    expect(review?.textContent).toBe("Review message");
    review.dispatch("click");
    expect(confirmReview).toHaveBeenCalledOnce();
    expect(draft.text).toBe("");
    expect(f.composer.lifecycle.paused(scope)).toHaveLength(1);
    if (change === "environment") f.switchSession("another", "dev");
    if (change === "draft") f.type("New unsent text");
    approval.resolve(change !== "cancel");
    await vi.waitFor(() => expect(f.composer.lifecycle.paused(scope)).toHaveLength(change === "approve" ? 0 : 1));
    expect(draft.text).toBe(change === "approve" ? "Unconfirmed message" : change === "draft" ? "New unsent text" : "");
    expect(f.requests).toHaveLength(0);
  },
);
