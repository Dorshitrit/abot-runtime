import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { SchedulerRun } from "../scheduler/contracts.js";
import {
  createConversationFileFixture,
  type ConversationFileFixture,
} from "./support/conversation-file-test-fixture.js";

const io = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((path: string) => Promise<void>),
  afterRead: undefined as undefined | (() => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const beforeOpen = io.beforeOpen;
      io.beforeOpen = undefined;
      await beforeOpen?.(String(args[0]));
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle);
      handle.read = (async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        const result = await read(buffer, offset, length, position);
        const afterRead = io.afterRead;
        io.afterRead = undefined;
        await afterRead?.();
        return result;
      }) as FileHandle["read"];
      return handle;
    },
  };
});

let fixture: ConversationFileFixture;
beforeEach(async () => {
  fixture = await createConversationFileFixture();
});
afterEach(async () => {
  io.beforeOpen = undefined;
  io.afterRead = undefined;
  await fixture.close();
});

async function recordFile() {
  const path = join(fixture.paths.agentWorkDir, "file.txt");
  await writeFile(path, "original");
  await fixture.record(fixture.receipt("file.txt"));
  return path;
}

describe("conversation file read races", () => {
  it("rejects an intermediate directory swapped outside the root before open", async () => {
    const directory = join(fixture.paths.agentWorkDir, "nested");
    await mkdir(directory);
    await writeFile(join(directory, "file.txt"), "original");
    await fixture.record(fixture.receipt("nested/file.txt"));
    const external = join(fixture.root, "external");
    await mkdir(external);
    await writeFile(join(external, "file.txt"), "outside-secret");
    io.beforeOpen = async () => {
      await rename(directory, directory + "-previous");
      await symlink(external, directory);
    };
    const response = await fixture.read();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("outside-secret");
  });

  it("rejects a leaf switched to a symlink between resolution and open", async () => {
    const path = await recordFile();
    const external = join(fixture.root, "outside.txt");
    await writeFile(external, "outside-secret");
    io.beforeOpen = async () => {
      await rename(path, path + "-previous");
      await symlink(external, path);
    };
    expect((await fixture.read()).status).toBe(404);
  });

  it("does not serve a file modified during the read", async () => {
    const path = await recordFile();
    io.afterRead = async () => {
      await writeFile(path, "changed contents");
    };
    const response = await fixture.read();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "conversation_file_changed",
    });
  });

  it("checks configured authority again after the read", async () => {
    await recordFile();
    io.afterRead = async () => {
      fixture.paths.agentWorkDir = fixture.paths.workspaceDir;
    };
    const response = await fixture.read();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "conversation_file_root_changed",
    });
  });

  it.each(["clear", "delete", "remove-environment"])(
    "does not return bytes after %s revokes the conversation during read",
    async (action) => {
      await recordFile();
      io.afterRead = async () => {
        if (action === "clear") {
          await fixture.sessions.clearSessionMessages("chat");
          return;
        }
        if (action === "delete") {
          await fixture.sessions.deleteSession("chat");
          return;
        }
        fixture.availableIds.delete("prod");
      };
      const response = await fixture.read({ download: "1" });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("original");
    },
  );
  it.each(["clear", "delete"])(
    "rejects a %s conversation recreated by a late event during the read",
    async (action) => {
      await recordFile();
      io.afterRead = async () => {
        if (action === "clear")
          await fixture.sessions.clearSessionMessages("chat");
        else await fixture.sessions.deleteSession("chat");
        await fixture.sessions.appendRequestEvent("chat", "request", {
          type: "event",
          name: "request.progress",
          requestId: "request",
        });
      };
      const response = await fixture.read({ download: "1" });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("original");
    },
  );

  it.each(["stored", "live"])(
    "does not restore %s authority from a queued completion after clear",
    async (source) => {
      await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "original");
      const receipt = fixture.receipt("file.txt");
      fixture.requests.scheduledRequestOptions({
        requestId: "request",
        sessionId: "chat",
        environmentId: "prod",
      } as SchedulerRun);
      fixture.requests.publishScheduled(fixture.completion(receipt));
      if (source === "stored") await fixture.record(receipt);
      io.afterRead = async () => {
        await fixture.sessions.clearSessionMessages("chat");
        await fixture.record(receipt);
      };
      expect((await fixture.read({ download: "1" })).status).toBe(404);
      expect((await fixture.read()).status).toBe(404);
      fixture.requests.publishScheduled({
        type: "completed",
        requestId: "request",
      });
      expect((await fixture.read()).status).toBe(404);
    },
  );

  it("rejects the same identifiers started again during an existing file read", async () => {
    await recordFile();
    io.afterRead = async () => {
      await fixture.sessions.clearSessionMessages("chat");
      await fixture.sessions.startRequestStream("chat", "request");
      await fixture.record(fixture.receipt("file.txt"));
    };
    expect((await fixture.read()).status).toBe(404);
    expect((await fixture.read()).status).toBe(200);
  });

  it("allows a live receipt to settle unchanged during the read", async () => {
    await writeFile(join(fixture.paths.agentWorkDir, "file.txt"), "original");
    const receipt = fixture.receipt("file.txt");
    fixture.requests.scheduledRequestOptions({
      requestId: "request",
      sessionId: "chat",
      environmentId: "prod",
    } as SchedulerRun);
    fixture.requests.publishScheduled(fixture.completion(receipt));
    io.afterRead = async () => {
      await fixture.record(receipt);
    };
    expect((await fixture.read()).status).toBe(200);
  });

  it("rechecks the recorded completion rather than only request membership", async () => {
    await recordFile();
    io.afterRead = async () => {
      await fixture.record(fixture.receipt("file.txt"), { ok: false });
      await fixture.record(fixture.receipt("file.txt"));
    };
    expect((await fixture.read()).status).toBe(404);
  });
});
