import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { readConversationFile } from "../../web-ui/local-runtime/conversation-file-content.js";
import { canOpenNativeConversationFile } from "../../web-ui/local-runtime/conversation-file-native-open.js";
import {
  createConversationFileFixture,
  type ConversationFileFixture,
} from "./support/conversation-file-test-fixture.js";

let fixture: ConversationFileFixture;
const launch = vi.fn(async (_path: string) => undefined);
beforeEach(async () => {
  launch.mockReset();
  fixture = await createConversationFileFixture({ platform: "darwin", launch });
});
afterEach(async () => {
  await fixture.close();
});

async function recordFile(name = "news.txt") {
  const path = join(fixture.paths.agentWorkDir, name);
  await writeFile(path, "current report");
  await fixture.record(fixture.receipt(name));
  return path;
}

describe("native conversation file opening", () => {
  it("keeps preview readable when a scoped IPv6 peer cannot use native opening", async () => {
    await recordFile();
    const request = {
      headers: { host: "localhost:5177" },
      socket: {
        remoteAddress: "fe80::1%en0",
        localAddress: "127.0.0.1",
        localPort: 5177,
      },
    } as IncomingMessage;
    const result = await readConversationFile(
      fixture.receipt("news.txt"),
      fixture.paths,
      "preview",
      (file) => canOpenNativeConversationFile(request, file, "darwin"),
    );
    expect(result.file).toMatchObject({
      content: "current report",
      nativeOpenAvailable: false,
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("offers opening on a local Mac and dispatches only the recorded path", async () => {
    const path = await recordFile("news $(touch nope);.txt");
    expect(await (await fixture.read()).json()).toMatchObject({
      file: { nativeOpenAvailable: true },
    });
    const response = await fixture.openNative({
      query: { path: "/etc/passwd", relativePath: "unrelated.txt" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("retains preview and download on a non-Mac without dispatching an app", async () => {
    await fixture.close();
    fixture = await createConversationFileFixture({
      platform: "linux",
      launch,
    });
    await recordFile();
    expect(await (await fixture.read()).json()).toMatchObject({
      file: { nativeOpenAvailable: false },
    });
    expect(await (await fixture.read({ download: "1" })).text()).toBe(
      "current report",
    );
    expect((await fixture.openNative()).status).toBe(415);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    "run.command",
    "run.sh",
    "run.app",
    "page.html",
    "image.svg",
    "module.js",
    "file",
    "report.docm",
  ])("does not launch %s", async (name) => {
    await recordFile(name);
    expect(await (await fixture.read()).json()).toMatchObject({
      file: { nativeOpenAvailable: false },
    });
    expect((await fixture.openNative()).status).toBe(415);
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects an executable document even with an allowed extension", async () => {
    const path = await recordFile();
    await chmod(path, 0o755);
    expect(await (await fixture.read()).json()).toMatchObject({
      file: { nativeOpenAvailable: false },
    });
    expect((await fixture.openNative()).status).toBe(415);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    { headers: { origin: "https://attacker.example" } },
    { headers: { origin: "" } },
    { headers: { "sec-fetch-site": "cross-site" } },
    { headers: { "content-type": "text/plain" } },
    { body: '{"path":"/etc/passwd"}' },
    { body: "null" },
    { body: "[ ]" },
    { body: "invalid" },
    { body: "x".repeat(1025) },
  ])(
    "rejects requests without a local JSON opening intent: %j",
    async (options) => {
      await recordFile();
      expect([400, 403, 415]).toContain(
        (await fixture.openNative(options)).status,
      );
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("never launches an app on GET", async () => {
    await recordFile();
    expect((await fixture.openNative({ method: "GET" })).status).toBe(404);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: "other" },
    { requestId: "other" },
    { executionId: "other" },
    { environment: "other" },
  ])("requires exact recorded authority %j", async (query) => {
    await recordFile();
    expect((await fixture.openNative({ query })).status).toBe(404);
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not open after request clear or completion revocation", async () => {
    await recordFile();
    await fixture.sessions.clearSessionMessages("chat");
    expect((await fixture.openNative()).status).toBe(404);
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(["replacement-root", "symlink"])(
    "does not open a %s",
    async (kind) => {
      const path = await recordFile();
      if (kind === "replacement-root") {
        const root = fixture.paths.agentWorkDir;
        await rename(root, root + "-previous");
        await mkdir(root);
        await writeFile(join(root, "news.txt"), "unrelated");
      } else {
        await rename(path, path + "-previous");
        await symlink(path + "-previous", path);
      }
      expect([404, 409]).toContain((await fixture.openNative()).status);
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("returns a bounded failure without disclosing a path when launching fails", async () => {
    await recordFile();
    launch.mockRejectedValueOnce(new Error("failed " + fixture.root));
    const response = await fixture.openNative();
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe("native_open_failed");
    expect(JSON.stringify(body)).not.toContain(fixture.root);
  });
});
