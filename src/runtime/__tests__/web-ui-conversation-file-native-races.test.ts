import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createConversationFileFixture,
  type ConversationFileFixture,
} from "./support/conversation-file-test-fixture.js";

let fixture: ConversationFileFixture;
const launch = vi.fn(async (_path: string) => undefined);
beforeEach(async () => {
  launch.mockClear();
  fixture = await createConversationFileFixture({ platform: "darwin", launch });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.close();
});

function beforeFinalAuthorityRead(action: () => Promise<void>) {
  const get = fixture.sessions.getRequestReplayById.bind(fixture.sessions);
  let reads = 0;
  vi.spyOn(fixture.sessions, "getRequestReplayById").mockImplementation(
    async (id) => {
      reads += 1;
      if (reads === 2) await action();
      return get(id);
    },
  );
}

describe("native opening revalidation before dispatch", () => {
  it.each([
    "clear",
    "environment",
    "root",
    "leaf-symlink",
    "changed-content",
    "executable",
  ])("rejects %s changes after the descriptor opened", async (kind) => {
    const path = join(fixture.paths.agentWorkDir, "report.txt");
    await writeFile(path, "original");
    await fixture.record(fixture.receipt("report.txt"));
    beforeFinalAuthorityRead(async () => {
      if (kind === "clear") {
        await fixture.sessions.clearSessionMessages("chat");
        return;
      }
      if (kind === "environment") {
        fixture.availableIds.delete("prod");
        return;
      }
      if (kind === "root") {
        const root = fixture.paths.agentWorkDir;
        await rename(root, root + "-old");
        await mkdir(root);
        await writeFile(join(root, "report.txt"), "unrelated");
        return;
      }
      if (kind === "leaf-symlink") {
        await rename(path, path + "-old");
        await symlink(path + "-old", path);
        return;
      }
      if (kind === "executable") {
        await chmod(path, 0o755);
        return;
      }
      await writeFile(path, "changed");
    });
    const response = await fixture.openNative();
    expect([404, 409]).toContain(response.status);
    expect(launch).not.toHaveBeenCalled();
  });
});
