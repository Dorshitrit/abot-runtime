import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createConversationFileFixture,
  type ConversationFileFixture,
} from "./support/conversation-file-test-fixture.js";
import type { SchedulerRun } from "../scheduler/contracts.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";

let fixture: ConversationFileFixture;
beforeEach(async () => {
  fixture = await createConversationFileFixture();
});
afterEach(async () => {
  await fixture.close();
});

describe("conversation file authority", () => {
  it("reads current UTF8 content and ignores client supplied paths and descriptors", async () => {
    const path = join(fixture.paths.agentWorkDir, "report.txt");
    await writeFile(path, "first version");
    await fixture.record(fixture.receipt("report.txt"));
    await writeFile(path, "הגרסה הנוכחית");
    const response = await fixture.read({
      path: "/etc/passwd",
      rootId: "forged",
      relativePath: "other.txt",
      descriptor: JSON.stringify({ logicalPath: "/etc/passwd" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      file: {
        name: "report.txt",
        kind: "text",
        content: "הגרסה הנוכחית",
        operation: "created",
        location: "report.txt",
        truncated: false,
      },
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it.each([
    { sessionId: "another" },
    { requestId: "another" },
    { executionId: "another" },
    { environment: "unknown" },
  ])("requires exact recorded ownership %j", async (overrides) => {
    await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "secret");
    await fixture.record(fixture.receipt("file.txt"));
    expect((await fixture.read(overrides)).status).toBe(404);
  });

  it.each([
    { ok: false },
    { name: "tool.started" },
    { type: "token" },
    { meta: {} },
  ])("does not promote failed or unrelated events %j", async (overrides) => {
    await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "secret");
    await fixture.record(fixture.receipt("file.txt"), overrides);
    expect((await fixture.read()).status).toBe(404);
  });

  it("supports actual generated identifiers and rejects control characters", async () => {
    await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "ok");
    await fixture.sessions.startRequestStream("abot-web-123-chat", "web-123");
    await fixture.sessions.appendRequestEvent("abot-web-123-chat", "web-123", {
      ...fixture.completion(fixture.receipt("file.txt")),
      executionId: "execution-files",
      requestId: "web-123",
    });
    expect(
      (
        await fixture.read({
          sessionId: "abot-web-123-chat",
          requestId: "web-123",
          executionId: "execution-files",
        })
      ).status,
    ).toBe(200);
    for (const id of [
      "slash/id",
      "back" + String.fromCharCode(92) + "slash",
      "control" + String.fromCharCode(0),
    ]) {
      expect((await fixture.read({ executionId: id })).status).toBe(400);
    }
  });

  it("rejects ambiguous receipts for one execution", async () => {
    await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "secret");
    await fixture.record(fixture.receipt("file.txt"));
    await fixture.record(fixture.receipt("file.txt"));
    expect((await fixture.read()).status).toBe(404);
  });

  it("revokes access when a session is deleted, cleared, or environment removed", async () => {
    await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "secret");
    await fixture.record(fixture.receipt("file.txt"));
    fixture.availableIds.delete("prod");
    expect((await fixture.read()).status).toBe(404);
    fixture.availableIds.add("prod");
    await fixture.sessions.clearSessionMessages("chat");
    expect((await fixture.read()).status).toBe(404);
    await fixture.record(fixture.receipt("file.txt"));
    await fixture.sessions.deleteSession("chat");
    expect((await fixture.read()).status).toBe(404);
  });

  it.each(["failed", "ambiguous"])(
    "never replaces a %s recorded completion with a live receipt",
    async (state) => {
      await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "secret");
      fixture.requests.scheduledRequestOptions({
        requestId: "request",
        sessionId: "chat",
        environmentId: "prod",
      } as SchedulerRun);
      fixture.requests.publishScheduled(
        fixture.completion(fixture.receipt("file.txt")),
      );
      await fixture.record(fixture.receipt("file.txt"), {
        ok: state !== "failed",
      });
      if (state === "ambiguous")
        await fixture.record(fixture.receipt("file.txt"));
      expect((await fixture.read()).status).toBe(404);
    },
  );

  it("rejects descriptor traversal, changed root identities and inconsistent namespaces", async () => {
    await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "secret");
    const valid = fixture.receipt("file.txt");
    for (const forged of [
      { ...valid, relativePath: "../file.txt", logicalPath: "../file.txt" },
      { ...valid, logicalPath: "workspace/file.txt" },
      { ...valid, rootId: "sha256:" + "0".repeat(64) },
      { ...valid, location: "host_system" },
    ]) {
      await fixture.sessions.clearSessionMessages("chat");
      await fixture.sessions.startRequestStream("chat", "request");
      await fixture.record(forged);
      const response = await fixture.read();
      expect([404, 409]).toContain(response.status);
      expect(await response.text()).not.toContain("secret");
    }
  });

  it("uses exact scoped live events while their persistence is pending", async () => {
    await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "live");
    fixture.requests.scheduledRequestOptions({
      requestId: "request",
      sessionId: "chat",
      environmentId: "prod",
    } as SchedulerRun);
    fixture.requests.publishScheduled(
      fixture.completion(fixture.receipt("file.txt")),
    );
    expect((await fixture.read()).status).toBe(200);
    expect((await fixture.read({ sessionId: "other" })).status).toBe(404);
    expect(
      fixture.requests.activeReplayForSession("request", "chat", "other"),
    ).toBeUndefined();
    await fixture.sessions.clearSessionMessages("chat");
    expect((await fixture.read()).status).toBe(404);
  });

  it("rejects cross-origin requests without reflecting origins or paths", async () => {
    for (const headers of [
      { origin: "https://example.org" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      const response = await fixture.read({}, headers);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(fixture.root);
    }
    expect((await fixture.read({ sessionId: "" })).status).toBe(400);
  });

  it("rejects a changed configured root even when the same filename exists there", async () => {
    await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "original");
    await fixture.record(fixture.receipt("file.txt"));
    const nextRoot = join(fixture.root, "new-agent");
    await mkdir(nextRoot);
    await writeFile(join(nextRoot, "file.txt"), "unrelated");
    fixture.paths.agentWorkDir = nextRoot;
    const response = await fixture.read();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "conversation_file_root_changed",
    });
  });

  it("rejects a root alias that was redirected", async () => {
    const alias = join(fixture.root, "alias");
    await symlink(fixture.paths.agentWorkDir, alias);
    fixture.paths.agentWorkDir = alias;
    await writeFile(join(alias, "file.txt"), "original");
    await fixture.record(fixture.receipt("file.txt"));
    await rename(alias, alias + "-old");
    await writeFile(join(fixture.paths.workspaceDir, "file.txt"), "unrelated");
    await symlink(fixture.paths.workspaceDir, alias);
    expect((await fixture.read()).status).toBe(409);
  });

  it.each(["leaf", "directory"])(
    "rejects a %s symlink escape",
    async (kind) => {
      const target = join(fixture.paths.agentWorkDir, "nested");
      await mkdir(target);
      await writeFile(join(target, "file.txt"), "original");
      await fixture.record(fixture.receipt("nested/file.txt"));
      const external = join(fixture.root, "external");
      await mkdir(external);
      await writeFile(join(external, "file.txt"), "secret");
      if (kind === "leaf") {
        await rename(join(target, "file.txt"), join(target, "previous.txt"));
        await symlink(join(external, "file.txt"), join(target, "file.txt"));
      } else {
        await rename(target, target + "-previous");
        await symlink(external, target);
      }
      expect((await fixture.read()).status).toBe(404);
    },
  );

  it("preserves the receipt location with overlapping roots and reserved folder names", async () => {
    const shared = fixture.paths.agentWorkDir;
    fixture.paths.workspaceDir = shared;
    await mkdir(join(shared, "workspace"));
    await writeFile(join(shared, "workspace", "file.txt"), "agent folder");
    await fixture.record(
      fixture.receipt(join(shared, "workspace", "file.txt")),
    );
    expect(await (await fixture.read()).json()).toMatchObject({
      file: { content: "agent folder", location: "workspace/file.txt" },
    });
    await fixture.sessions.clearSessionMessages("chat");
    await fixture.sessions.startRequestStream("chat", "request");
    await fixture.record(
      fixture.receipt("workspace/workspace/file.txt", "updated", "workspace"),
    );
    expect(await (await fixture.read()).json()).toMatchObject({
      file: {
        content: "agent folder",
        operation: "updated",
        location: "workspace/workspace/file.txt",
      },
    });
  });

  it("isolates the same request identifiers across environments", async () => {
    await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "prod");
    await fixture.record(fixture.receipt("file.txt"));
    fixture.availableIds.add("dev");
    fixture.environments.set("dev", {
      services: {
        config: { paths: fixture.paths },
        sessions: { getRequestReplayById: async () => null },
      },
    } as unknown as RuntimeEnvironment);
    expect((await fixture.read({ environment: "dev" })).status).toBe(404);
    expect((await fixture.read()).status).toBe(200);
  });
  it("requires a started request after clear, even when steering recreates user messages", async () => {
    await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "original");
    const receipt = fixture.receipt("file.txt");
    fixture.requests.scheduledRequestOptions({
      requestId: "request",
      sessionId: "chat",
      environmentId: "prod",
    } as SchedulerRun);
    fixture.requests.publishScheduled(fixture.completion(receipt));
    await fixture.record(receipt);
    await fixture.sessions.clearSessionMessages("chat");
    await fixture.sessions.appendMessage("chat", "user", "late steering", {
      source: "user",
      requestId: "request",
    });
    await fixture.sessions.appendRequestEvent("chat", "request", {
      type: "event",
      name: "request.progress",
      requestId: "request",
    });
    expect((await fixture.read()).status).toBe(404);
    await fixture.record(receipt);
    fixture.requests.publishScheduled({
      type: "completed",
      requestId: "request",
    });
    expect((await fixture.read()).status).toBe(404);
    await fixture.sessions.startRequestStream("chat", "new-request");
    await fixture.sessions.appendRequestEvent("chat", "new-request", {
      ...fixture.completion(receipt),
      requestId: "new-request",
    });
    expect((await fixture.read({ requestId: "new-request" })).status).toBe(200);
  });
});
