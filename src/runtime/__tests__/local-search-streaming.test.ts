import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import createLocalSearchSource from "../../../plugins/local-search/source/index.js";
import { resolveSearchRoot } from "../../../plugins/local-search/source/paths.js";
import { runRipgrepContentSearch } from "../../../plugins/local-search/source/ripgrep.js";
import { PLUGIN_RESULT_SERIALIZED_MAX_BYTES } from "../../plugin-sdk/results.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";

const temporaryRoots: string[] = [];
const inheritedRipgrepConfigPath = process.env.RIPGREP_CONFIG_PATH;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (inheritedRipgrepConfigPath === undefined) {
    delete process.env.RIPGREP_CONFIG_PATH;
  } else {
    process.env.RIPGREP_CONFIG_PATH = inheritedRipgrepConfigPath;
  }
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

function pluginContextFor(root: string) {
  const pluginRoot = join(process.cwd(), "plugins", "local-search");
  const workspaceDir = join(root, "workspace");
  const runtimePaths = {
    rootDir: root,
    runtimeDir: join(root, ".runtime"),
    agentWorkDir: root,
    sessionsDir: join(root, ".runtime", "sessions"),
    attachmentsDir: join(root, ".runtime", "attachments"),
    workspaceDir,
    sharedDir: join(root, "shared"),
    compiledDir: join(root, "compiled"),
    traceFile: join(root, ".runtime", "trace.ndjson"),
  };
  return {
    id: "local-search",
    path: join(pluginRoot, "plugin.json"),
    stateDir: join(root, ".runtime", "plugins", "local-search"),
    rootDir: root,
    runtimeId: "local-search-streaming-test",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    pluginRoot,
    runtimePaths,
    runtimePathResolver: createRuntimeToolPathResolver(runtimePaths),
    config: {},
  };
}

function handlerFor(root: string) {
  return createLocalSearchSource(pluginContextFor(root)).handlers.local_search;
}

describe("local-search streaming ripgrep boundary", () => {
  test("ignores inherited ripgrep configuration", async () => {
    const root = await createRoot("local-search-config");
    await mkdir(join(root, "workspace"));
    const configPath = join(root, "ripgrep.config");
    await writeFile(configPath, "--definitely-not-a-real-ripgrep-option\n");
    await writeFile(join(root, "needle-\uFFFD-file.txt"), "safe\n", "utf8");
    process.env.RIPGREP_CONFIG_PATH = configPath;

    const result = await handlerFor(root)(
      {
        query: "needle",
        mode: "names",
        max_results: 10,
      },
      undefined,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        hasData: true,
        itemCount: 1,
        truncation: { sourceTruncated: false },
      },
    });
    expect(result.output).toContain("- needle-\uFFFD-file.txt");
  });

  test("stops a large content stream after proving truncation", async () => {
    const root = await createRoot("local-search-large");
    await mkdir(join(root, "workspace"));
    const line = `streaming-boundary-token ${"x".repeat(1_000)}\n`;
    await writeFile(join(root, "large.txt"), line.repeat(5_000), "utf8");

    const result = await handlerFor(root)(
      {
        query: "streaming-boundary-token",
        mode: "content",
        max_results: 3,
      },
      undefined,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        hasData: true,
        itemCount: 3,
        truncation: {
          truncated: true,
          sourceTruncated: true,
          candidateItems: 3,
          returnedItems: 3,
        },
      },
    });
    expect(result.output).toContain("large.txt:1:streaming-boundary-token");
    expect(result.output).toContain("large.txt:3:streaming-boundary-token");
    expect(result.output).not.toContain("large.txt:4:streaming-boundary-token");
  });

  test("reports omitted content when filename matches fill a both-mode budget", async () => {
    const root = await createRoot("local-search-both-budget");
    await mkdir(join(root, "workspace"));
    await writeFile(
      join(root, "needle-name.txt"),
      "needle appears in content too\n",
      "utf8",
    );

    const result = await handlerFor(root)(
      {
        query: "needle",
        mode: "both",
        max_results: 1,
      },
      undefined,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        itemCount: 1,
        truncation: {
          truncated: true,
          sourceTruncated: true,
          candidateItems: 1,
          returnedItems: 1,
        },
      },
    });
    expect(result.output).toContain("Filename matches:");
    expect(result.output).not.toContain("Content matches:");
    expect(result.output).toContain("Additional matches were omitted.");
  });

  test("budgets the complete serialized result for multibyte and control-heavy matches", async () => {
    const root = await createRoot("local-search-result-bytes");
    await mkdir(join(root, "workspace"));
    const line = `byte-budget-token ${"\u001b".repeat(400)}${"界".repeat(400)}\n`;
    await writeFile(join(root, "adversarial.txt"), line.repeat(260), "utf8");

    const result = await handlerFor(root)(
      {
        query: "byte-budget-token",
        mode: "content",
        max_results: 200,
      },
      undefined,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        hasData: true,
        truncation: { truncated: true },
      },
    });
    expect(result.output).toContain("界");
    expect(result.output).toContain("�");
    expect(result.output).not.toContain("\u001b");
    expect(
      Buffer.byteLength(JSON.stringify(result), "utf8"),
    ).toBeLessThanOrEqual(PLUGIN_RESULT_SERIALIZED_MAX_BYTES);
  });

  test.each(["directory", "file"] as const)(
    "does not search outside a verified %s authority after pathname replacement",
    async (kind) => {
      const root = await createRoot(`local-search-authority-${kind}`);
      const outside = await createRoot(`local-search-outside-${kind}`);
      await mkdir(join(root, "workspace"));
      const requested = kind === "directory" ? "selected" : "selected.txt";
      const target = join(root, requested);
      const moved = join(outside, `moved-${kind}`);
      const attacker = join(outside, `attacker-${kind}`);
      if (kind === "directory") {
        await mkdir(target);
        await mkdir(attacker);
        await writeFile(
          join(target, "safe.txt"),
          "authority-swap-token safe\n",
          "utf8",
        );
        await writeFile(
          join(attacker, "outside.txt"),
          "authority-swap-token outside\n",
          "utf8",
        );
      } else {
        await writeFile(target, "authority-swap-token safe\n", "utf8");
        await writeFile(attacker, "authority-swap-token outside\n", "utf8");
      }

      const authority = await resolveSearchRoot(
        pluginContextFor(root),
        requested,
      );
      try {
        await rename(target, moved);
        await symlink(attacker, target, kind === "directory" ? "dir" : "file");
        const search = runRipgrepContentSearch(
          [
            "--json",
            "--with-filename",
            "--fixed-strings",
            "--line-number",
            "--no-heading",
            "--color",
            "never",
            "--",
            "authority-swap-token",
            authority.commandTarget,
          ],
          authority.commandDirectory,
          10,
          undefined,
          authority.stdinFd,
          authority.directoryAuthority,
        );
        const rejectsReplacedDirectory =
          kind === "directory" && process.platform === "darwin";
        if (rejectsReplacedDirectory) {
          await expect(search).rejects.toMatchObject({
            code: "local_search_failed",
          });
          return;
        }
        const result = await search;
        expect(result.items.map(({ text }) => text)).toEqual([
          "authority-swap-token safe",
        ]);
      } finally {
        await authority.close();
      }
    },
  );

  test("preserves exact-file filename search semantics without reopening the file pathname", async () => {
    const root = await createRoot("local-search-file-name");
    await mkdir(join(root, "workspace"));
    await writeFile(join(root, "Needle-File.txt"), "content\n", "utf8");
    const handler = handlerFor(root);

    const insensitive = await handler(
      {
        query: "needle-file",
        path: "Needle-File.txt",
        mode: "names",
      },
      undefined,
    );
    const sensitive = await handler(
      {
        query: "needle-file",
        path: "Needle-File.txt",
        mode: "names",
        case_sensitive: true,
      },
      undefined,
    );

    expect(insensitive).toMatchObject({
      ok: true,
      data: { itemCount: 1 },
    });
    expect(insensitive.output).toContain("Needle-File.txt");
    expect(sensitive).toMatchObject({
      ok: true,
      data: { itemCount: 0 },
    });
  });

  test.each(["names", "content"] as const)(
    "searches %s through a real directory helper with macOS authority selection",
    async (mode) => {
      const root = await createRoot("local-search-directory-helper");
      await mkdir(join(root, "workspace"));
      await writeFile(join(root, "needle.txt"), "needle bridge content\n");
      vi.stubGlobal(
        "process",
        new Proxy(process, {
          get(target, property, receiver) {
            if (property === "platform") return "darwin";
            return Reflect.get(target, property, receiver);
          },
        }),
      );
      const result = await handlerFor(root)(
        { query: "needle", mode },
        undefined,
      );
      expect(result).toMatchObject({
        ok: true,
        data: { itemCount: 1, hasData: true },
      });
      expect(result.output).toContain("needle.txt");
    },
  );
});
