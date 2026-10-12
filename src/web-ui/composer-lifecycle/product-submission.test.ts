import { afterEach, expect, test, vi } from "vitest";
import { composerProductFixture, deferred } from "./__tests__/composer-product-fixture.js";

afterEach(() => vi.unstubAllGlobals());
const attachment = { id: "file-1", name: "notes.txt", storageRef: "chat-1/file-1", mimeType: "text/plain", sessionId: "chat-1", environment: "prod" };

test("actual Chat composition sends a captured draft without awaiting unrelated persistence", async () => {
  const save = deferred<Response>();
  const requests: unknown[] = [];
  const fetchImpl = vi.fn(async (url, input) => {
    if (url === "/web-ui-state" && !input?.body) return new Response(JSON.stringify({ state: { version: 1, revision: 0, preferences: {}, queue: "" } }));
    if (url === "/web-ui-state") return save.promise;
    requests.push(JSON.parse(input.body));
    return new Response('{"requestId":"accepted"}');
  });
  const f = await composerProductFixture({ fetchImpl: fetchImpl as typeof fetch });
  const saving = f.storage.setItem("abot-web.pinnedSessions", '["pinned"]');
  f.workspace.chatDraft().attachments = [attachment];
  f.type("Hello");
  const sending = f.composer.submit.dispatch();
  expect(f.dom.composerInput.value).toBe("");
  expect(f.statuses.at(-1)).toBe("ABot is working.");
  expect((await sending)?.status).toBe("accepted");
  expect(requests).toEqual([expect.objectContaining({ text: "Hello", environment: "prod", sessionId: "chat-1", attachments: [attachment], toolPermissionMode: "ask" })]);
  expect(f.activated).toEqual(["accepted"]);
  save.resolve(new Response(JSON.stringify({ state: { version: 1, revision: 1, preferences: {}, queue: "" } })));
  await saving;
});

test("actual Home activation and send preserve files after refusal, using the shared composition", async () => {
  const post = deferred<Response>();
  const fetchImpl = vi.fn(async (url, input) => {
    if (url === "/web-ui-state") return new Response(JSON.stringify({ state: { version: 1, revision: 0, preferences: {}, queue: "" } }));
    return post.promise;
  });
  const f = await composerProductFixture({ fetchImpl: fetchImpl as typeof fetch });
  f.showHome();
  const homeFile = { ...attachment, sessionId: "home-1", storageRef: "home-1/file-1" };
  f.workspace.homeDraft().attachments = [homeFile];
  f.type("From Home");
  const sending = f.home.dispatch();
  await vi.waitFor(() => expect(fetchImpl.mock.calls.some(([url]) => url === "/web-api/chat/messages")).toBe(true));
  f.switchSession("other", "dev");
  f.type("Different draft");
  post.resolve(new Response('{"error":"model_invalid","message":"Choose a model"}', { status: 400 }));
  expect((await sending)?.status).toBe("refused");
  expect(f.dom.composerInput.value).toBe("Different draft");
  const original = f.workspace.drafts.open({ environmentId: "prod", sessionId: "home-1" });
  expect(original.text).toBe("From Home");
  expect(original.attachments).toEqual([homeFile]);
  expect(f.activated).toEqual([]);
});

test("a lost POST response leaves new input and uploads untouched after navigation", async () => {
  const post = deferred<Response>();
  const fetchImpl = vi.fn(async (url) => {
    if (url === "/web-ui-state") return new Response(JSON.stringify({ state: { version: 1, revision: 0, preferences: {}, queue: "" } }));
    return post.promise;
  });
  const f = await composerProductFixture({ fetchImpl: fetchImpl as typeof fetch });
  f.workspace.chatDraft().attachments = [attachment];
  f.type("Unconfirmed");
  const sending = f.composer.submit.dispatch();
  await vi.waitFor(() => expect(fetchImpl.mock.calls.some(([url]) => url === "/web-api/chat/messages")).toBe(true));
  f.type("New draft");
  f.workspace.chatDraft().attachments = [{ ...attachment, id: "new", storageRef: "chat-1/new" }];
  f.switchSession("other");
  post.reject(new Error("Disconnected"));
  expect((await sending)?.status).toBe("uncertain");
  f.switchSession("chat-1");
  expect(f.dom.composerInput.value).toBe("New draft");
  expect(f.workspace.chatDraft().attachments).toHaveLength(1);
  expect(f.workspace.chatDraft().attachments[0].id).toBe("new");
  expect(f.composer.lifecycle.paused({ environmentId: "prod", sessionId: "chat-1" })).toHaveLength(1);
});
