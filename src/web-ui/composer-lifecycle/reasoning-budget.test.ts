import { afterEach, expect, test, vi } from "vitest";
import { composerHttpFixture } from "./__tests__/composer-http-fixture.js";
import { deferred } from "./__tests__/composer-product-fixture.js";
import type { ModelReasoningPreference } from "../../shared/model-reasoning.js";

const fixtures: Array<Awaited<ReturnType<typeof composerHttpFixture>>> = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((item) => item.close())); vi.unstubAllGlobals(); });
test("Send next persists the captured budget through server state and ignores later control changes", async () => {
  let preference: ModelReasoningPreference = { profileId: "model", mode: "budget", budgetTokens: 128 };
  const f = await composerHttpFixture({ getSettings: () => ({
    agentMode: "fast", toolPermissionMode: "ask", modelPreference: { profileId: "model" }, reasoningPreference: preference,
  }) });
  fixtures.push(f);
  f.state.activeRequestId = "active";
  f.type("Next message");
  expect((await f.composer.submit.dispatch("send_next")).status).toBe("accepted");
  preference = { profileId: "model", mode: "off" };
  await f.storage.refresh();
  f.state.activeRequestId = "";
  await f.composer.queue.drain({ environmentId: "prod", sessionId: "chat-1", terminalRequestId: "active" });
  expect(f.messages).toEqual([expect.objectContaining({
    reasoningPreference: { profileId: "model", mode: "budget", budgetTokens: 128 }, agentMode: "fast",
  })]);
});

test("a request captures its preference before async submission and later messages use the new choice", async () => {
  const acknowledgement = deferred();
  const preference = { profileId: "model", mode: "budget" as const, budgetTokens: 256 };
  const f = await composerHttpFixture({
    getSettings: () => ({ agentMode: "fast", toolPermissionMode: "ask", modelPreference: { profileId: "model" }, reasoningPreference: preference }),
    chat: async () => { await acknowledgement.promise; return Response.json({ requestId: "accepted" }); },
  });
  fixtures.push(f);
  f.type("First");
  const sending = f.composer.submit.dispatch();
  preference.budgetTokens = 512;
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  expect(f.messages[0].reasoningPreference.budgetTokens).toBe(256);
  acknowledgement.resolve();
  await sending;
  f.state.activeRequestId = "";
  f.type("Second");
  await f.composer.submit.dispatch();
  expect(f.messages[1].reasoningPreference.budgetTokens).toBe(512);
});
