import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createInMemorySessionStore } from "../runtime/adapters/in-memory-session-store.js";
import {
  MAX_SESSION_ARTIFACT_PATHS,
  MAX_SESSION_ARTIFACT_PATH_TARGET_LENGTH,
  upsertSessionArtifactPaths,
} from "./artifact-paths.js";
import { SessionService } from "./session-service.js";
import type { SessionArtifactPath } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("upsertSessionArtifactPaths", () => {
  test("dedupes exact targets and refreshes their recency and provenance", () => {
    const existing: SessionArtifactPath[] = [
      {
        target: "news/news.txt",
        sourceRequestId: "req-1",
        sourceExecutionId: "exec-1",
        createdAt: "2026-08-14T08:00:00.000Z",
        updatedAt: "2026-08-14T08:00:00.000Z",
      },
      {
        target: "summary.txt",
        sourceRequestId: "req-2",
        sourceExecutionId: "exec-2",
        createdAt: "2026-08-14T08:01:00.000Z",
        updatedAt: "2026-08-14T08:01:00.000Z",
      },
    ];

    const result = upsertSessionArtifactPaths(
      existing,
      [
        {
          target: "news/news.txt",
          sourceRequestId: "req-3",
          sourceExecutionId: "exec-3",
        },
        {
          target: "News/news.txt",
          sourceRequestId: "req-3",
          sourceExecutionId: "exec-4",
        },
      ],
      "2026-08-14T08:02:00.000Z",
    );

    expect(result.map(({ target }) => target)).toEqual([
      "summary.txt",
      "news/news.txt",
      "News/news.txt",
    ]);
    expect(result[1]).toEqual({
      target: "news/news.txt",
      sourceRequestId: "req-3",
      sourceExecutionId: "exec-3",
      createdAt: "2026-08-14T08:00:00.000Z",
      updatedAt: "2026-08-14T08:02:00.000Z",
    });
  });

  test("retains only the 64 most recent exact targets", () => {
    const result = upsertSessionArtifactPaths(
      [],
      Array.from({ length: MAX_SESSION_ARTIFACT_PATHS + 1 }, (_, index) => ({
        target: `artifact-${index}.txt`,
        sourceRequestId: "req-cap",
        sourceExecutionId: `exec-${index}`,
      })),
      "2026-08-14T08:00:00.000Z",
    );

    expect(result).toHaveLength(MAX_SESSION_ARTIFACT_PATHS);
    expect(result[0]?.target).toBe("artifact-1.txt");
    expect(result.at(-1)?.target).toBe("artifact-64.txt");
  });

  test("rejects empty or oversized targets and empty source ids", () => {
    expect(() =>
      upsertSessionArtifactPaths(
        [],
        [
          {
            target: " ",
            sourceRequestId: "req-1",
            sourceExecutionId: "exec-1",
          },
        ],
        "2026-08-14T08:00:00.000Z",
      ),
    ).toThrow("session_artifact_path_target_required");
    expect(() =>
      upsertSessionArtifactPaths(
        [],
        [
          {
            target: "x".repeat(MAX_SESSION_ARTIFACT_PATH_TARGET_LENGTH + 1),
            sourceRequestId: "req-1",
            sourceExecutionId: "exec-1",
          },
        ],
        "2026-08-14T08:00:00.000Z",
      ),
    ).toThrow("session_artifact_path_target_too_long");
    expect(() =>
      upsertSessionArtifactPaths(
        [],
        [
          {
            target: "news.txt",
            sourceRequestId: "",
            sourceExecutionId: "exec-1",
          },
        ],
        "2026-08-14T08:00:00.000Z",
      ),
    ).toThrow("session_artifact_path_source_request_id_required");
    expect(() =>
      upsertSessionArtifactPaths(
        [],
        [
          {
            target: "news.txt",
            sourceRequestId: "req-1",
            sourceExecutionId: " ",
          },
        ],
        "2026-08-14T08:00:00.000Z",
      ),
    ).toThrow("session_artifact_path_source_execution_id_required");
  });
});

describe("session artifact path stores", () => {
  test("persists a batch across file-store reload and clears it on reset", async () => {
    const sessionsDir = await mkdtemp(
      join(tmpdir(), "llm-runtime-artifact-paths-"),
    );
    tempDirs.push(sessionsDir);
    await new SessionService({
      sessionsDir,
      now: () => new Date("2026-08-14T08:00:00.000Z"),
    }).getOrCreateSession("sess-artifacts");

    await new SessionService({
      sessionsDir,
      now: () => new Date("2026-08-14T08:01:00.000Z"),
    }).upsertArtifactPaths("sess-artifacts", [
      {
        target: "news/news.txt",
        sourceRequestId: "req-1",
        sourceExecutionId: "exec-1",
      },
    ]);

    const reloaded = new SessionService({
      sessionsDir,
      now: () => new Date("2026-08-14T08:02:00.000Z"),
    });
    expect(
      (await reloaded.getSessionById("sess-artifacts"))?.artifactPaths,
    ).toEqual([
      {
        target: "news/news.txt",
        sourceRequestId: "req-1",
        sourceExecutionId: "exec-1",
        createdAt: "2026-08-14T08:01:00.000Z",
        updatedAt: "2026-08-14T08:01:00.000Z",
      },
    ]);

    await reloaded.resetSession("sess-artifacts");
    expect(
      (await reloaded.getSessionById("sess-artifacts"))?.artifactPaths,
    ).toEqual([]);
  });

  test("implements the same batch contract in memory", async () => {
    const store = createInMemorySessionStore({
      now: () => new Date("2026-08-14T08:00:00.000Z"),
    });

    const session = await store.upsertArtifactPaths!("sess-memory", [
      {
        target: "news/news.txt",
        sourceRequestId: "req-1",
        sourceExecutionId: "exec-1",
      },
    ]);
    expect(session.artifactPaths?.map(({ target }) => target)).toEqual([
      "news/news.txt",
    ]);

    await store.clearSessionMessages("sess-memory");
    expect((await store.getSessionById("sess-memory"))?.artifactPaths).toEqual(
      [],
    );
  });
});
