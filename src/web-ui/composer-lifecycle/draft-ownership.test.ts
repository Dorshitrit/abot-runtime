import { expect, test, vi } from "vitest";
import { createComposerDrafts } from "../app/controllers/composer-drafts.js";
import { createComposerSubmissionLifecycle, ComposerSubmissionRefused } from "../app/controllers/composer-submission-lifecycle.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const original = { environmentId: "prod", sessionId: "original" };
const other = { environmentId: "dev", sessionId: "other" };
const file = (id: string) => ({ id, storageRef: `${original.sessionId}/${id}`, sessionId: original.sessionId, environment: original.environmentId });

function setup() {
  const drafts = createComposerDrafts();
  const draft = drafts.open(original);
  draft.text = "Original text";
  draft.attachments = [file("original")];
  const lifecycle = createComposerSubmissionLifecycle({ drafts });
  return { drafts, draft, lifecycle };
}

test("a late definite refusal restores the complete originating draft without replacing later input", async () => {
  const { drafts, draft, lifecycle } = setup();
  const preparation = deferred();
  const execute = vi.fn();
  const submitted = lifecycle.submit({ draft, action: "send", prepare: () => preparation.promise, execute });
  expect(draft.text).toBe("");
  expect(draft.attachments).toEqual([]);
  draft.text = "New input";
  draft.attachments = [file("new")];
  const destination = drafts.open(other);
  destination.text = "Other conversation";
  preparation.reject(new Error("Activation declined"));
  expect((await submitted).status).toBe("refused");
  expect(execute).not.toHaveBeenCalled();
  expect(draft.text).toBe("Original text\nNew input");
  expect(draft.attachments.map((item) => item.id)).toEqual(["original", "new"]);
  expect(destination.text).toBe("Other conversation");
  expect(lifecycle.hasPendingScope(original)).toBe(false);
});

test("lost POST acknowledgement keeps its payload separate from a new draft until explicit review", async () => {
  const { draft, lifecycle } = setup();
  const post = deferred();
  const execute = vi.fn(() => post.promise);
  const submitted = lifecycle.submit({ draft, action: "send", execute });
  await Promise.resolve();
  draft.text = "Next draft";
  draft.attachments = [file("next")];
  post.reject(new Error("Network disconnected"));
  const result = await submitted;
  expect(result.status).toBe("uncertain");
  expect(execute).toHaveBeenCalledOnce();
  expect(draft.text).toBe("Next draft");
  expect(draft.attachments).toEqual([file("next")]);
  expect(lifecycle.ownsAttachment(file("original"))).toBe(true);
  expect(await lifecycle.restoreForManualReview(result.attempt.id, () => false)).toBe(false);
  expect(lifecycle.paused(original)).toHaveLength(1);
  expect(await lifecycle.restoreForManualReview(result.attempt.id, () => true)).toBe(true);
  expect(draft.text).toBe("Original text\nNext draft");
  expect(lifecycle.paused(original)).toHaveLength(0);
  expect(execute).toHaveBeenCalledOnce();
});

test("an ambiguous preparation ACK does not become an automatically resubmittable draft", async () => {
  const { draft, lifecycle } = setup();
  const error = Object.assign(new Error("Enqueue ACK lost"), { workspaceMutationMayHaveCommitted: true });
  const execute = vi.fn();
  const result = await lifecycle.submit({ draft, action: "send_next", prepare: () => { throw error; }, execute });
  expect(result.status).toBe("uncertain");
  expect(draft.isEmpty()).toBe(true);
  expect(lifecycle.ownsAttachment(file("original"))).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});

test("an explicit HTTP refusal can restore after the effect boundary, without retrying", async () => {
  const { draft, lifecycle } = setup();
  const execute = vi.fn(async () => { throw new ComposerSubmissionRefused("Rejected"); });
  expect((await lifecycle.submit({ draft, action: "send", execute })).status).toBe("refused");
  expect(draft.text).toBe("Original text");
  expect(draft.attachments).toEqual([file("original")]);
  expect(execute).toHaveBeenCalledOnce();
});

test("post-acceptance queue bookkeeping failure cannot turn an accepted request into a resend", async () => {
  const { draft, lifecycle } = setup();
  const post = vi.fn(async () => "request-1");
  const result = await lifecycle.submit({ draft, action: "send", execute: post, accepted: () => { throw new Error("Bind failed"); } });
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error("Expected acceptance");
  expect(result.result).toBe("request-1");
  expect(result.bookkeepingError).toBeInstanceOf(Error);
  expect((result.bookkeepingError as Error).message).toBe("Bind failed");
  expect(draft.isEmpty()).toBe(true);
  expect(lifecycle.paused(original)).toHaveLength(0);
  expect(post).toHaveBeenCalledOnce();
});

test("upload completion remains owned by its original draft after another scope is opened", () => {
  const { drafts, draft } = setup();
  const generation = draft.startUpload();
  drafts.open(other).text = "Unrelated";
  expect(draft.acceptUpload(generation, file("uploaded"))).toBe(true);
  draft.finishUpload(generation);
  expect(draft.attachments.map((item) => item.id)).toEqual(["original", "uploaded"]);
  expect(drafts.open(other).attachments).toEqual([]);
  const stale = draft.startUpload();
  draft.take();
  expect(draft.acceptUpload(stale, file("late"))).toBe(false);
});
