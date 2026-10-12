import { afterEach, expect, test, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { composerHttpFixture } from "./__tests__/composer-http-fixture.js";
import { deferred } from "./__tests__/composer-product-fixture.js";

const fixtures: Array<Awaited<ReturnType<typeof composerHttpFixture>>> = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.close())); vi.unstubAllGlobals(); });
const scope = { environmentId: "prod", sessionId: "chat-1" };

test("normal POST starts while a preference ACK is held, with immediate click feedback", async () => {
  const preferenceAck = deferred();
  const preferencePending = deferred();
  let postAt = 0;
  const f = await composerHttpFixture({
    afterMutation: async (input) => {
      if (input.kind !== "preference") return;
      preferencePending.resolve();
      await preferenceAck.promise;
    },
    chat: async () => { postAt = performance.now(); return Response.json({ requestId: "accepted" }); },
  });
  fixtures.push(f);
  const saving = f.storage.setItem("abot-web.pinnedSessions", '["pin"]');
  await preferencePending.promise;
  f.type("Immediate request");
  const clickedAt = performance.now();
  const sending = f.composer.submit.dispatch();
  const feedbackAt = performance.now();
  expect(f.dom.composerInput.value).toBe("");
  expect(f.statuses.at(-1)).toBe("ABot is working.");
  expect((await sending).status).toBe("accepted");
  expect(f.messages).toHaveLength(1);
  console.info(JSON.stringify({ fixture: "normal-send-held-preference", feedbackMs: feedbackAt - clickedAt, postMs: postAt - clickedAt }));
  preferenceAck.resolve();
  await saving;
});

test("queue-owned send acknowledges the click but waits for its own begin ACK before POST", async () => {
  const beginAck = deferred();
  const beginPending = deferred();
  let holdBegin = false;
  let postAt = 0;
  const f = await composerHttpFixture({
    afterMutation: async (input) => {
      if (input.action !== "begin" || !holdBegin) return;
      beginPending.resolve();
      await beginAck.promise;
    },
    chat: async () => { postAt = performance.now(); return Response.json({ requestId: "accepted" }); },
  });
  fixtures.push(f);
  f.state.activeRequestId = "old";
  f.type("Queued instruction");
  await f.composer.submit.dispatch("send_next");
  f.state.activeRequestId = "";
  await f.composer.queue.drain({ ...scope, terminalRequestId: "old", cancelled: true });
  holdBegin = true;
  const clickedAt = performance.now();
  const sending = f.composer.submit.dispatch();
  const feedbackAt = performance.now();
  expect(f.dom.composerInput.value).toBe("");
  expect(f.statuses.at(-1)).toBe("ABot is working.");
  await beginPending.promise;
  expect(f.messages).toHaveLength(0);
  const ackAt = performance.now();
  beginAck.resolve();
  expect((await sending).status).toBe("accepted");
  expect(postAt).toBeGreaterThanOrEqual(ackAt);
  console.info(JSON.stringify({ fixture: "queued-send-held-begin", feedbackMs: feedbackAt - clickedAt, postMs: postAt - clickedAt, ownershipWaitMs: ackAt - clickedAt }));
});
