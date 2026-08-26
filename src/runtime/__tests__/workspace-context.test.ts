import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createWorkspaceContextProvider } from "../context/workspace-context.js";

describe("workspace context", () => {
  test("reloads compiled summary when the file changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-context-"));
    const summaryPath = join(root, "compiled", "workspace-summary.json");
    await mkdir(join(root, "compiled"), { recursive: true });

    try {
      await writeFile(
        summaryPath,
        JSON.stringify({
          sourceHash: "hash-1",
          generatedAt: "2026-01-01T00:00:00.000Z",
          files: ["a.md"],
          summary: "first",
        }),
        "utf-8",
      );

      const provider = createWorkspaceContextProvider({
        compiledPath: summaryPath,
      });
      const first = await provider.getWorkspaceSystemSummary();
      expect(first).toContain("first");

      await writeFile(
        summaryPath,
        JSON.stringify({
          sourceHash: "hash-2",
          generatedAt: "2026-01-01T00:00:01.000Z",
          files: ["a.md"],
          summary: "second",
        }),
        "utf-8",
      );

      const second = await provider.getWorkspaceSystemSummary();
      expect(second).toBe("second");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns empty summary when compiled file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-context-missing-"));
    const summaryPath = join(root, "compiled", "workspace-summary.json");

    try {
      const provider = createWorkspaceContextProvider({
        compiledPath: summaryPath,
      });
      await expect(provider.getWorkspaceSystemSummary()).resolves.toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reloads when the compiled summary appears after an initial miss", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-context-late-"));
    const summaryPath = join(root, "compiled", "workspace-summary.json");
    await mkdir(join(root, "compiled"), { recursive: true });

    try {
      const provider = createWorkspaceContextProvider({
        compiledPath: summaryPath,
      });

      const fallback = await provider.getWorkspaceSystemSummary();
      expect(fallback).toBe("");

      await writeFile(
        summaryPath,
        JSON.stringify({
          sourceHash: "hash-later",
          generatedAt: "2026-01-01T00:00:02.000Z",
          files: ["a.md"],
          summary: "appeared later",
        }),
        "utf-8",
      );

      const reloaded = await provider.getWorkspaceSystemSummary();
      expect(reloaded).toBe("appeared later");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
