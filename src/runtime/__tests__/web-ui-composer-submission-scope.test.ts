import { afterEach, describe, expect, test, vi } from "vitest";
import { createComposerProductionHarness } from "./support/composer-production-harness.js";
afterEach(() => vi.unstubAllGlobals());

function pending() {
  let resolve!: (id: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

describe("web ui pending composer submission ownership", () => {
  test.each(["session", "environment"] as const)("settles an old request independently after changing %s", async (scope) => {
    const h = createComposerProductionHarness();
    h.state.activeRequestId = "";
    const first = pending();
    const second = pending();
    h.client.postChatMessage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const oldScope = h.workspace.chatDraft().scope;
    h.type("Old request");
    const oldSending = h.composer.submit.dispatch();
    await vi.waitFor(() => expect(h.client.postChatMessage).toHaveBeenCalledOnce());
    if (scope === "session") h.switchSession("other-chat");
    else h.setEnvironmentId("prod");
    h.type("New conversation request");
    const newSending = h.composer.submit.dispatch();
    await vi.waitFor(() => expect(h.client.postChatMessage).toHaveBeenCalledTimes(2));
    h.type("New conversation draft");
    first.reject(new Error("Old transport failure"));
    expect(await oldSending).toMatchObject({ status: "uncertain" });
    expect(h.composer.lifecycle.hasPendingScope(h.workspace.chatDraft().scope)).toBe(true);
    expect(h.dom.composerInput.value).toBe("New conversation draft");
    expect(h.composer.lifecycle.paused(oldScope)).toHaveLength(1);
    expect(h.onControlEvent).not.toHaveBeenCalled();
    expect(h.dom.composerInput.focus).not.toHaveBeenCalled();
    second.resolve("new-request");
    expect(await newSending).toMatchObject({ status: "accepted" });
  });

  test("refreshing the same view keeps newer input separate from an unconfirmed send", async () => {
    const h = createComposerProductionHarness();
    h.state.activeRequestId = "";
    const post = pending();
    h.client.postChatMessage.mockReturnValueOnce(post.promise);
    h.type("Older request");
    const sending = h.composer.submit.dispatch();
    h.state.sessionViewVersion += 1;
    h.type("New draft after refresh");
    post.reject(new Error("Lost response"));
    expect(await sending).toMatchObject({ status: "uncertain" });
    expect(h.dom.composerInput.value).toBe("New draft after refresh");
    expect(h.composer.lifecycle.paused(h.workspace.chatDraft().scope)[0].payload.text).toBe("Older request");
    expect(h.composer.lifecycle.hasPendingScope(h.workspace.chatDraft().scope)).toBe(false);
  });

  test("binds the complete submission to a synchronously created session", async () => {
    const h = createComposerProductionHarness();
    h.state.activeRequestId = "";
    h.switchSession("");
    h.type("First request");
    expect(await h.composer.submit.dispatch()).toMatchObject({ status: "accepted" });
    expect(h.client.postChatMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "First request", sessionId: "created-chat" }));
    expect(h.session.activateRequestForScope).toHaveBeenCalledWith({ environmentId: "dev", sessionId: "created-chat" }, "new-request");
    expect(h.composer.lifecycle.hasPendingScope(h.workspace.chatDraft().scope)).toBe(false);
  });

  test("reports current-scope failures and pauses uncertain payload without blocking new input", async () => {
    const h = createComposerProductionHarness();
    h.state.activeRequestId = "";
    h.client.postChatMessage.mockRejectedValueOnce(new Error("Disconnected"));
    h.type("Question");
    expect(await h.composer.submit.dispatch()).toMatchObject({ status: "uncertain" });
    expect(h.onControlEvent).toHaveBeenCalledWith(expect.objectContaining({ tone: "failed" }));
    expect(h.composer.lifecycle.hasPendingScope(h.workspace.chatDraft().scope)).toBe(false);
    expect(h.dom.composerInput.value).toBe("");
    expect(h.composer.lifecycle.paused(h.workspace.chatDraft().scope)).toHaveLength(1);
  });

  test("settles a background Chat request without focusing Home", async () => {
    const h = createComposerProductionHarness();
    h.state.activeRequestId = "";
    const post = pending();
    h.client.postChatMessage.mockReturnValueOnce(post.promise);
    h.type("Chat request");
    const sending = h.composer.submit.dispatch();
    h.feature.setWorkspace("home");
    h.type("Home draft");
    post.resolve("accepted-request");
    await sending;
    expect(h.dom.composerInput.value).toBe("Home draft");
    expect(h.dom.composerInput.focus).not.toHaveBeenCalled();
  });
});
