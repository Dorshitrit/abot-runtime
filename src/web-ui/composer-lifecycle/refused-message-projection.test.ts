import { afterEach, expect, test, vi } from "vitest";
import { composerHttpFixture } from "./__tests__/composer-http-fixture.js";
import { deferred } from "./__tests__/composer-product-fixture.js";

const fixtures: Array<Awaited<ReturnType<typeof composerHttpFixture>>> = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.close())); vi.unstubAllGlobals(); });
async function fixture(options: Parameters<typeof composerHttpFixture>[0] = {}) {
  const f = await composerHttpFixture(options); fixtures.push(f); return f;
}
const rejected = () => Response.json({ message: "Choose a model" }, { status: 400 });
const accepted = () => Response.json({ requestId: "accepted" });
const userRows = (f: Awaited<ReturnType<typeof fixture>>) => f.state.messages.filter((m: any) => m.role === "user");

test.each(["chat", "home", "queued"])("%s removes only its refused optimistic row before manual retry", async (surface) => {
  let refuse = true;
  const f = await fixture({ chat: async () => refuse ? rejected() : accepted() });
  if (surface === "home") f.showHome();
  f.type("One instruction");
  if (surface === "queued") {
    f.state.activeRequestId = "previous";
    await f.composer.submit.dispatch("send_next");
    f.state.activeRequestId = "";
    await f.composer.queue.drain({ environmentId: "prod", sessionId: "chat-1", terminalRequestId: "previous" });
  } else {
    const submit = surface === "home" ? f.home : f.composer.submit;
    expect((await submit.dispatch()).status).toBe("refused");
  }
  expect(userRows(f)).toEqual([]);
  expect(f.dom.composerInput.value).toBe("One instruction");
  refuse = false;
  expect((await f.composer.submit.dispatch()).status).toBe("accepted");
  expect(userRows(f).map((m: any) => m.text)).toEqual(["One instruction"]);
  expect(f.messages).toHaveLength(2);
});

test("a refusal after navigation cannot remove another view's same-text message", async () => {
  const response = deferred<Response>();
  const f = await fixture({ chat: () => response.promise });
  f.type("Same text");
  const sending = f.composer.submit.dispatch();
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  f.switchSession("different", "dev");
  const current = { id: "other-message", role: "user", text: "Same text" };
  f.state.messages = [current];
  response.resolve(rejected());
  expect((await sending).status).toBe("refused");
  expect(f.state.messages).toEqual([current]);
  expect(f.workspace.drafts.open({ environmentId: "prod", sessionId: "chat-1" }).text).toBe("Same text");
});

test("an unconfirmed response preserves its visible row and stays paused without retry", async () => {
  const f = await fixture({ chat: async () => Response.json({ message: "No acknowledgement" }, { status: 503 }) });
  f.type("Unconfirmed instruction");
  expect((await f.composer.submit.dispatch()).status).toBe("uncertain");
  expect(userRows(f).map((m: any) => m.text)).toEqual(["Unconfirmed instruction"]);
  expect(f.composer.lifecycle.paused({ environmentId: "prod", sessionId: "chat-1" })).toHaveLength(1);
  expect(f.messages).toHaveLength(1);
});
