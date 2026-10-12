import { afterEach, expect, test, vi } from "vitest";
import { deferred } from "./__tests__/composer-product-fixture.js";
import { composerHttpFixture } from "./__tests__/composer-http-fixture.js";

const fixtures: Array<Awaited<ReturnType<typeof composerHttpFixture>>> = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.close())); vi.unstubAllGlobals(); });
async function fixture(options: Parameters<typeof composerHttpFixture>[0] = {}) {
  const f = await composerHttpFixture(options); fixtures.push(f); return f;
}
const scope = { environmentId: "prod", sessionId: "chat-1" };
const recoveryButton = (f: Awaited<ReturnType<typeof fixture>>) => f.dom.composerForm.querySelector(".composer-submission-notice")?.querySelector("button");

async function stopWithAnotherDraft(f: Awaited<ReturnType<typeof fixture>>) {
  f.state.activeRequestId = "previous";
  f.type("Queued instruction");
  await f.composer.submit.dispatch("send_next");
  f.type("Independent draft");
  f.state.activeRequestId = "";
  await f.composer.queue.drain({ ...scope, terminalRequestId: "previous", cancelled: true });
  expect(f.queueStore.getBlockedRelease(scope)).not.toBeNull();
  expect(recoveryButton(f)?.textContent).toBe("Review queued message");
  expect(recoveryButton(f)?.disabled).toBe(true);
  expect(f.dom.composerInput.value).toBe("Independent draft");
}

test.each(["clear", "send"])("after %s of another draft, Stop recovery is explicit and causes no POST", async (action) => {
  const f = await fixture();
  await stopWithAnotherDraft(f);
  if (action === "clear") f.type("");
  else expect((await f.composer.submit.dispatch()).status).toBe("accepted");
  expect(recoveryButton(f)?.disabled).toBe(false);
  expect(f.dom.composerInput.value).toBe("");
  const posts = f.messages.length;
  recoveryButton(f)?.dispatch("click");
  await vi.waitFor(() => expect(f.dom.composerInput.value).toBe("Queued instruction"));
  expect(f.messages).toHaveLength(posts);
  expect(f.queueStore.getBlockedRelease(scope)?.owner.state).toBe("editing");
  expect(recoveryButton(f)).toBeNull();
});

test("an uncertain queued submission has only its existing manual review action", async () => {
  const f = await fixture({ chat: async () => Response.json({ message: "Unknown" }, { status: 503 }) });
  f.state.activeRequestId = "previous";
  f.type("Queued instruction");
  await f.composer.submit.dispatch("send_next");
  f.state.activeRequestId = "";
  await f.composer.queue.drain({ ...scope, terminalRequestId: "previous" });
  expect(recoveryButton(f)?.textContent).toBe("Review message");
  expect(f.dom.composerForm.textContent).not.toContain("Review queued message");
  expect(f.messages).toHaveLength(1);
});


test("accepted manual recovery has no recovery action during or after its binding ACK", async () => {
  const bound = deferred();
  const binding = deferred();
  const f = await fixture({ afterMutation: async (input) => {
    if (input.action !== "bind") return;
    binding.resolve();
    await bound.promise;
  } });
  await stopWithAnotherDraft(f);
  f.type("");
  recoveryButton(f)?.dispatch("click");
  await vi.waitFor(() => expect(f.dom.composerInput.value).toBe("Queued instruction"));
  const sending = f.composer.submit.dispatch();
  try {
    await binding.promise;
    expect(f.activated).toEqual(["accepted-1"]);
    expect(f.messages).toHaveLength(1);
    expect(recoveryButton(f)).toBeNull();
  } finally { bound.resolve(); await sending; }
  expect(f.queueStore.getBlockedRelease(scope)).toBeNull();
  expect(recoveryButton(f)).toBeNull();
});
