import { describe, expect, test, vi } from "vitest";
import {
  createConversationFilePreviewController,
  type FilePreviewViewState,
} from "../../web-ui/app/controllers/conversation-file-preview-controller.js";
import type {
  ConversationFileClient,
  ConversationFilePreview,
  ConversationFileRequest,
} from "../../web-ui/app/services/runtime-web-client/conversation-files.js";
import type { ConversationFileReference } from "../../web-ui/app/lib/conversation-file-reference.js";

const reference: ConversationFileReference = {
  requestId: "r1",
  executionId: "e1",
  output: {
    version: 1,
    location: "agent_work",
    rootId: "sha256:" + "a".repeat(64),
    relativePath: "report.txt",
    logicalPath: "report.txt",
    operation: "created",
  },
};
const file: ConversationFilePreview = {
  name: "report.txt",
  mimeType: "text/plain",
  size: 5,
  kind: "text",
  operation: "created",
  content: "hello",
  truncated: false,
  downloadAvailable: true,
};
function setup() {
  let scope = { environmentId: "prod", sessionId: "s1", activeRequestId: "" };
  const pending: {
    input: ConversationFileRequest;
    resolve: (result: { ok: true; file: ConversationFilePreview }) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const views: FilePreviewViewState[] = [];
  const nativePending: {
    input: ConversationFileRequest;
    resolve: (result: { ok: true }) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const client: ConversationFileClient = {
    supportsConversationFiles: () => true,
    loadConversationFile(input) {
      return new Promise((resolve, reject) =>
        pending.push({ input, resolve, reject }),
      );
    },
    openConversationFile(input) {
      return new Promise((resolve, reject) =>
        nativePending.push({ input, resolve, reject }),
      );
    },
    conversationFileUrl: vi.fn(
      (input) =>
        "/web-api/chat/files?executionId=" +
        input.executionId +
        "&mode=" +
        input.mode,
    ),
  };
  const controller = createConversationFilePreviewController({
    client,
    getScope: () => scope,
    render: (view) => views.push(view),
  });
  return {
    controller,
    pending,
    nativePending,
    views,
    client,
    scope(next: Partial<typeof scope>) {
      scope = { ...scope, ...next };
    },
  };
}

describe("conversation file preview lifecycle", () => {
  test.each([
    {
      code: "conversation_file_changed",
      expected:
        "The file changed while it was being read. Open it again to view its latest contents.",
    },
    {
      code: "conversation_file_root_changed",
      expected:
        "The file location has changed. This recorded action can no longer open it.",
    },
    {
      code: "unknown_conflict",
      expected: "The file could not be loaded. Try opening it again.",
    },
  ])(
    "presents the distinct 409 outcome for $code",
    async ({ code, expected }) => {
      const { controller, pending, views } = setup();
      const opening = controller.open(reference);
      pending[0].reject({
        status: 409,
        code,
        message: "/private/internal/file",
      });
      await opening;
      expect(views.at(-1)?.error).toBe(expected);
      expect(JSON.stringify(views)).not.toContain("/private/internal");
    },
  );

  test("loads only exact correlation IDs and exposes URLs after a valid preview", async () => {
    const { controller, pending, views } = setup();
    const opening = controller.open(reference);
    expect(views.at(-1)).toMatchObject({ open: true, status: "loading" });
    expect(pending[0].input).toMatchObject({
      environmentId: "prod",
      sessionId: "s1",
      requestId: "r1",
      executionId: "e1",
    });
    expect(pending[0].input).not.toHaveProperty("path");
    pending[0].resolve({ ok: true, file });
    await opening;
    expect(views.at(-1)).toMatchObject({ status: "ready", file, imageUrl: "" });
  });

  test("a slower file cannot overwrite the newer selection", async () => {
    const { controller, pending, views } = setup();
    const first = controller.open(reference);
    const second = controller.open({ ...reference, executionId: "e2" });
    expect(pending[0].input.signal?.aborted).toBe(true);
    pending[1].resolve({ ok: true, file: { ...file, content: "second" } });
    await second;
    pending[0].resolve({ ok: true, file });
    await first;
    expect(views.at(-1)?.file?.content).toBe("second");
  });

  test("close cancels work and an ignored abort cannot reopen the viewer", async () => {
    const { controller, pending, views } = setup();
    const opening = controller.open(reference);
    controller.close();
    expect(pending[0].input.signal?.aborted).toBe(true);
    expect(views.at(-1)).toEqual({ open: false, restoreFocus: true });
    pending[0].resolve({ ok: true, file });
    await opening;
    expect(views.at(-1)?.open).toBe(false);
  });

  test.each([
    { sessionId: "s2" },
    { environmentId: "dev" },
    { activeRequestId: "new-request" },
  ])(
    "scope transition closes and invalidates a pending preview %j",
    async (next) => {
      const { controller, pending, views, scope } = setup();
      const opening = controller.open(reference);
      scope(next);
      controller.syncScope();
      expect(views.at(-1)).toEqual({ open: false, restoreFocus: false });
      pending[0].resolve({ ok: true, file });
      await opening;
      expect(views.at(-1)?.open).toBe(false);
    },
  );

  test("ordinary stream paints and completion keep the same preview open", async () => {
    const { controller, pending, views, scope } = setup();
    scope({ activeRequestId: "r1" });
    const opening = controller.open(reference);
    controller.syncScope();
    pending[0].resolve({ ok: true, file });
    await opening;
    scope({ activeRequestId: "" });
    controller.syncScope();
    expect(views.at(-1)?.status).toBe("ready");
  });

  test("scope change rejects a late response even before the next UI paint", async () => {
    const { controller, pending, views, scope } = setup();
    const opening = controller.open(reference);
    scope({ sessionId: "s2" });
    pending[0].resolve({ ok: true, file });
    await opening;
    expect(views.some((view) => view.status === "ready")).toBe(false);
  });

  test("internal path errors are replaced with a safe unavailable state", async () => {
    const { controller, pending, views } = setup();
    const opening = controller.open(reference);
    pending[0].reject({
      status: 404,
      message: "/unavailable-root/private/path",
    });
    await opening;
    expect(views.at(-1)?.error).toBe("This file is no longer available.");
    expect(JSON.stringify(views)).not.toContain("/unavailable-root/private");
  });

  test("image URL follows backend availability", async () => {
    const { controller, pending, views } = setup();
    const opening = controller.open(reference);
    pending[0].resolve({
      ok: true,
      file: {
        ...file,
        kind: "image",
        mimeType: "image/png",
        downloadAvailable: false,
      },
    });
    await opening;
    expect(views.at(-1)?.imageUrl).toContain("mode=content");
    expect(views.at(-1)).not.toHaveProperty("downloadUrl");
  });
});

describe("scoped native file opening", () => {
  async function loaded(available = true) {
    const state = setup();
    const opening = state.controller.open(reference);
    state.pending[0].resolve({
      ok: true,
      file: { ...file, nativeOpenAvailable: available },
    });
    await opening;
    return state;
  }

  test("requires backend eligibility and only sends reference IDs on a click", async () => {
    const state = await loaded(false);
    await state.controller.openNative();
    expect(state.nativePending).toHaveLength(0);
    const enabled = await loaded();
    expect(enabled.nativePending).toHaveLength(0);
    const first = enabled.controller.openNative();
    await enabled.controller.openNative();
    expect(enabled.nativePending).toHaveLength(1);
    expect(enabled.nativePending[0].input).toMatchObject({
      environmentId: "prod",
      sessionId: "s1",
      requestId: "r1",
      executionId: "e1",
    });
    expect(enabled.nativePending[0].input).not.toHaveProperty("path");
    enabled.nativePending[0].resolve({ ok: true });
    await first;
    expect(enabled.views.at(-1)).toMatchObject({
      status: "native",
      nativeStatus: "opened",
    });
  });

  test("closing cancels a pending launch response without reopening the viewer", async () => {
    const state = await loaded();
    const launching = state.controller.openNative();
    state.controller.close();
    expect(state.nativePending[0].input.signal?.aborted).toBe(true);
    state.nativePending[0].resolve({ ok: true });
    await launching;
    expect(state.views.at(-1)?.open).toBe(false);
  });

  test("rejects stale scope and sanitizes a native app error", async () => {
    const state = await loaded();
    state.scope({ sessionId: "different" });
    await state.controller.openNative();
    expect(state.nativePending).toHaveLength(0);
    const current = await loaded();
    const launching = current.controller.openNative();
    current.nativePending[0].reject({ message: "/private/user/file.txt" });
    await launching;
    expect(current.views.at(-1)).toMatchObject({
      status: "native",
      nativeStatus: "error",
      nativeError: "The file could not be opened on your Mac.",
    });
    expect(JSON.stringify(current.views)).not.toContain("/private/user");
  });
});
