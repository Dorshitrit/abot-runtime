import { afterEach, expect, test, vi } from "vitest";
import { composerHttpFixture } from "./__tests__/composer-http-fixture.js";
import { deferred } from "./__tests__/composer-product-fixture.js";

const fixtures: Array<Awaited<ReturnType<typeof composerHttpFixture>>> = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.close())); vi.unstubAllGlobals(); });
const message = "This conversation already has an active request. Wait for it to finish or stop it before sending another message.";
const busy = () => Response.json({ ok: false, error: "session_busy", message }, { status: 409 });

test.each(["session_busy", "session_awaiting_approval"])("%s restores text and attachments without retry or an optimistic message", async (error) => {
  const f = await composerHttpFixture({ chat: async () => Response.json({ ok: false, error, message }, { status: 409 }) }); fixtures.push(f);
  const scope = { environmentId: "prod", sessionId: "chat-1" };
  const draft = f.workspace.drafts.open(scope);
  const attachment = { id: "file", name: "notes.txt", mimeType: "text/plain", storageRef: "chat-1/file", sessionId: "chat-1", environment: "prod" };
  draft.attachments = [attachment];
  f.type("Follow up");
  expect((await f.composer.submit.dispatch()).status).toBe("refused");
  expect(draft.text).toBe("Follow up");
  expect(draft.attachments).toEqual([attachment]);
  expect(f.state.messages.filter((entry: any) => entry.role === "user")).toEqual([]);
  expect(f.statuses).toContain(message);
  expect(f.activated).toEqual([]);
  expect(f.composer.lifecycle.paused(scope)).toEqual([]);
  expect(f.messages).toHaveLength(1);
});

test("a late busy refusal restores only its originating conversation and preserves later typing", async () => {
  const response = deferred<Response>();
  const f = await composerHttpFixture({ chat: () => response.promise }); fixtures.push(f);
  f.type("First draft");
  const sending = f.composer.submit.dispatch();
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  f.type("Later typing");
  f.switchSession("other");
  f.type("Other draft");
  response.resolve(busy());
  expect((await sending).status).toBe("refused");
  expect(f.workspace.drafts.open({ environmentId: "prod", sessionId: "chat-1" }).text).toBe("First draft\nLater typing");
  expect(f.dom.composerInput.value).toBe("Other draft");
  expect(f.messages).toHaveLength(1);
});
