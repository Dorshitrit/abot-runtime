import { afterEach, expect, test, vi } from "vitest";
import { composerHttpFixture } from "../composer-lifecycle/__tests__/composer-http-fixture.js";
import { deferred } from "../composer-lifecycle/__tests__/composer-product-fixture.js";

const fixtures: Array<Awaited<ReturnType<typeof composerHttpFixture>>> = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.close())); vi.unstubAllGlobals(); });

test.each([409, 413, 500, 503])("queue status %s preserves captured files after navigation", async (status) => {
  const ack = deferred<Response>();
  const entered = deferred();
  const f = await composerHttpFixture({ beforeMutation: async (input) => {
    if (input.action !== "enqueue") return;
    entered.resolve();
    return ack.promise;
  } });
  fixtures.push(f);
  const file = { id: "file", name: "notes.txt", mimeType: "text/plain", storageRef: "chat-1/file", sessionId: "chat-1", environment: "prod" };
  const scope = { environmentId: "prod", sessionId: "chat-1" };
  const deleteAttachment = vi.spyOn(f.client, "deleteAttachment");
  f.workspace.chatDraft().attachments = [file];
  f.type("Queued text");
  f.state.activeRequestId = "active";
  const saving = f.composer.submit.dispatch("send_next");
  await entered.promise;
  f.switchSession("other", "dev");
  f.type("Unrelated draft");
  ack.resolve(Response.json({ message: "State operation failed" }, { status }));
  const result = await saving;
  expect(deleteAttachment).not.toHaveBeenCalled();
  expect(f.workspace.chatDraft().text).toBe("Unrelated draft");
  if (status < 500) {
    expect(result.status).toBe("refused");
    expect(f.workspace.drafts.open(scope).attachments).toEqual([file]);
    expect(f.workspace.drafts.open(scope).text).toBe("Queued text");
  } else {
    expect(result.status).toBe("uncertain");
    expect(f.workspace.drafts.open(scope).isEmpty()).toBe(true);
    expect(f.composer.lifecycle.paused(scope)[0].payload.attachments).toEqual([file]);
  }
  await expect(f.storage.flush()).rejects.toThrow("State operation failed");
  expect(f.mutations.filter((input) => input.action === "enqueue")).toHaveLength(1);
});
