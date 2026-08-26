import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  ensureSessionsDir,
  loadSessionFile,
  saveSessionFile,
} from "./session-store.js";
import type { SessionRecord } from "./types.js";

const tempDirs: string[] = [];

async function createTempSessionsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llm-runtime-session-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("session-store", () => {
  test("publishes complete session files without leaving temp files", async () => {
    const sessionsDir = await createTempSessionsDir();
    await ensureSessionsDir(sessionsDir);

    const session: SessionRecord = {
      id: "sess-atomic",
      title: "sess-atomic",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastAgentMode: "reasoning",
      messageCount: 1,
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "hello",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };

    await saveSessionFile(sessionsDir, session);

    await expect(loadSessionFile(sessionsDir, session.id)).resolves.toEqual(
      session,
    );
    const files = await readdir(sessionsDir);
    expect(files).toEqual(["sess-atomic.json"]);
  });
});
