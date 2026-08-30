import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PUBLIC_PACKAGE_FILES,
  PUBLIC_PACKAGE_SCRIPT_OVERRIDES,
  PUBLIC_PACKAGE_SCRIPT_NAMES,
  PUBLIC_PLUGIN_IDS,
  PUBLIC_ROOT_OVERLAYS,
  PUBLIC_SCRIPT_FILES,
  PUBLIC_SNAPSHOT_FILE_NAME,
  PUBLIC_SNAPSHOT_SCHEMA_VERSION,
  REQUIRED_PUBLIC_DIRECTORIES,
  REQUIRED_PUBLIC_SOURCE_FILES,
  REQUIRED_PUBLIC_SNAPSHOT_FILES,
  assertExactPublicPluginPackagePaths,
  assertNoSnapshotPathCollisions,
  assertPrivateSourcePackageLock,
  assertPrivateSourcePackageJson,
  buildPublicSnapshot,
  decodePublicSnapshotManifest,
  transformPublicPackageLock,
  transformPublicPackageJson,
  verifyPublicSnapshot,
} from "../../../scripts/public-snapshot/index.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

type TestManifest = Readonly<{
  schemaVersion: 1;
  directories: readonly string[];
  plugins: readonly string[];
  files: readonly string[];
}>;

function makeManifest(extraFiles: readonly string[] = []): TestManifest {
  return {
    schemaVersion: PUBLIC_SNAPSHOT_SCHEMA_VERSION,
    plugins: [...PUBLIC_PLUGIN_IDS],
    directories: [...REQUIRED_PUBLIC_DIRECTORIES],
    files: [...REQUIRED_PUBLIC_SNAPSHOT_FILES, ...extraFiles],
  };
}

async function writeFixtureFile(
  sourceRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const target = join(sourceRoot, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
}

async function commitFixture(
  sourceRoot: string,
  message = "fixture state",
): Promise<void> {
  await execFileAsync("git", [
    "-C",
    sourceRoot,
    "config",
    "user.email",
    "fixture@example.invalid",
  ]);
  await execFileAsync("git", [
    "-C",
    sourceRoot,
    "config",
    "user.name",
    "Fixture",
  ]);
  await execFileAsync("git", ["-C", sourceRoot, "add", "--all"]);
  await execFileAsync("git", [
    "-C",
    sourceRoot,
    "commit",
    "--quiet",
    "--message",
    message,
  ]);
}

function createPackageJson(): Record<string, unknown> {
  return {
    name: "@fixture/public-runtime",
    version: "1.2.3",
    description: "Fixture public runtime",
    license: "MIT",
    keywords: ["fixture"],
    engines: { node: ">=20" },
    exports: { ".": "./dist/index.js" },
    private: true,
    type: "module",
    scripts: {
      ...Object.fromEntries(
        PUBLIC_PACKAGE_SCRIPT_NAMES.map((name) => [name, `fixture ${name}`]),
      ),
      "internal:canary": "tsx scripts/internal-canary.ts",
    },
    files: ["plugins/", "internal/"],
  };
}

function createPackageLock(): Record<string, unknown> {
  const packageJson = createPackageJson();
  return {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: packageJson.name,
        version: packageJson.version,
        private: true,
      },
    },
  };
}

function createPluginJson(pluginId: string): string {
  return `${JSON.stringify(
    {
      name: pluginId,
      version: "1.0.0",
      extensions: {
        "ai.abot.runtime": {
          version: 1,
          entrypoint: "./src/index.cjs",
          capabilities: {},
        },
      },
    },
    null,
    2,
  )}\n`;
}

async function createFixture(extraFiles: readonly string[] = []): Promise<{
  parent: string;
  sourceRoot: string;
  manifest: TestManifest;
}> {
  const parent = await mkdtemp(join(tmpdir(), "abot-public-snapshot-test-"));
  temporaryRoots.push(parent);
  const sourceRoot = join(parent, "source");
  await mkdir(sourceRoot);
  const manifest = makeManifest(extraFiles);

  for (const relativePath of manifest.files) {
    if (Object.hasOwn(PUBLIC_ROOT_OVERLAYS, relativePath)) {
      continue;
    }
    if (relativePath === "package.json") {
      await writeFixtureFile(
        sourceRoot,
        relativePath,
        `${JSON.stringify(createPackageJson(), null, 2)}\n`,
      );
      continue;
    }
    if (relativePath === "package-lock.json") {
      await writeFixtureFile(
        sourceRoot,
        relativePath,
        `${JSON.stringify(createPackageLock(), null, 2)}\n`,
      );
      continue;
    }
    if (relativePath === "public-snapshot.manifest.json") {
      await writeFixtureFile(
        sourceRoot,
        relativePath,
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      continue;
    }
    const content = relativePath.endsWith(".json")
      ? "{}\n"
      : `fixture: ${relativePath}\n`;
    await writeFixtureFile(sourceRoot, relativePath, content);
  }

  await writeFixtureFile(
    sourceRoot,
    "examples/minimal-runtime-composition.ts",
    "export {};\n",
  );
  await writeFixtureFile(
    sourceRoot,
    "examples/request-runner.config.example.json",
    "{}\n",
  );
  await writeFixtureFile(
    sourceRoot,
    "examples/runtime.config.example.json",
    "{}\n",
  );
  await writeFixtureFile(sourceRoot, "methodologies/example.md", "# Example\n");
  await writeFixtureFile(
    sourceRoot,
    "scripts/public-snapshot/fixture.ts",
    "export {};\n",
  );
  await writeFixtureFile(sourceRoot, "src/fixture.ts", "export {};\n");
  for (const pluginId of PUBLIC_PLUGIN_IDS) {
    await writeFixtureFile(
      sourceRoot,
      `plugins/${pluginId}/plugin.json`,
      createPluginJson(pluginId),
    );
    await writeFixtureFile(
      sourceRoot,
      `plugins/${pluginId}/src/index.cjs`,
      "module.exports = {};\n",
    );
  }

  await writeFixtureFile(
    sourceRoot,
    ".env.example",
    "INTERNAL_CANARY_TOKEN=internal-value\n",
  );
  await writeFixtureFile(
    sourceRoot,
    ".gitignore",
    "!plugins/internal-canary/**\n",
  );
  await execFileAsync("git", ["-C", sourceRoot, "init", "--quiet"]);
  await commitFixture(sourceRoot, "initial fixture");
  return { parent, sourceRoot, manifest };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("public snapshot manifest", () => {
  it("accepts an explicit allowlist with exactly the ten public plugins", () => {
    const decoded = decodePublicSnapshotManifest(makeManifest());

    expect(decoded.plugins).toEqual(PUBLIC_PLUGIN_IDS);
    expect(decoded.directories).toEqual([...decoded.directories].sort());
    expect(decoded.files).toEqual([...decoded.files].sort());
  });

  it("rejects a non-public plugin canary and path traversal", () => {
    const base = makeManifest();

    expect(() =>
      decodePublicSnapshotManifest({
        ...base,
        plugins: [...PUBLIC_PLUGIN_IDS.slice(0, -1), "internal-canary"],
      }),
    ).toThrow(/exactly/);
    expect(() =>
      decodePublicSnapshotManifest(makeManifest(["src/../internal.ts"])),
    ).toThrow(/traversal/);
  });

  it("rejects case-folding and Unicode-normalization collisions", () => {
    expect(() =>
      assertNoSnapshotPathCollisions(["src/Case.ts", "src/case.ts"]),
    ).toThrow(/collision/);
    expect(() =>
      assertNoSnapshotPathCollisions(["src/caf\u00e9.ts", "src/cafe\u0301.ts"]),
    ).toThrow(/collision/);
  });

  it("rejects directory overlap and reads the checked root manifest", async () => {
    const base = makeManifest();
    expect(() =>
      decodePublicSnapshotManifest({
        ...base,
        directories: [...base.directories, "src/runtime"],
      }),
    ).toThrow(/collision|overlapping|exactly/);

    const checked = decodePublicSnapshotManifest(
      JSON.parse(
        await readFile(
          join(process.cwd(), "public-snapshot.manifest.json"),
          "utf-8",
        ),
      ) as unknown,
    );
    expect(checked.plugins).toEqual(PUBLIC_PLUGIN_IDS);
    expect(checked.directories).toEqual(
      [...REQUIRED_PUBLIC_DIRECTORIES].sort(),
    );
  });
});

describe("public package transform", () => {
  it("retains only public scripts and exact public package files", () => {
    const transformed = transformPublicPackageJson(createPackageJson());

    expect(Object.keys(transformed.scripts as Record<string, string>)).toEqual(
      PUBLIC_PACKAGE_SCRIPT_NAMES,
    );
    expect(transformed.private).toBe(false);
    expect(transformed.files).toEqual(PUBLIC_PACKAGE_FILES);
    expect(transformed.scripts).not.toHaveProperty("internal:canary");
    expect(
      (transformed.scripts as Record<string, string>)["check:publication"],
    ).toBe(PUBLIC_PACKAGE_SCRIPT_OVERRIDES["check:publication"]);
    expect(transformed.scripts).not.toHaveProperty("build:public-snapshot");
    expect(
      (transformed.scripts as Record<string, string>).validate,
    ).not.toContain("git ");
    expect((transformed.scripts as Record<string, string>).validate).toContain(
      "npm run check:public-snapshot",
    );
    expect(PUBLIC_PACKAGE_FILES).not.toContain("plugins/");
    expect(PUBLIC_PACKAGE_FILES).not.toContain("plugins/internal-canary/");
    expect([...PUBLIC_PACKAGE_SCRIPT_NAMES]).not.toContain(
      "e2e:session-history-memory",
    );
    for (const privateSmokeFile of [
      "scripts/session-history-memory/contract.ts",
      "scripts/session-history-memory/oracle.ts",
      "scripts/session-history-memory/run.ts",
    ]) {
      expect([...PUBLIC_SCRIPT_FILES]).not.toContain(privateSmokeFile);
      expect([...REQUIRED_PUBLIC_SOURCE_FILES]).not.toContain(privateSmokeFile);
    }
  });

  it("refuses to build a public package from an unguarded source package", () => {
    const packageJson = createPackageJson();
    delete packageJson.private;

    expect(() => assertPrivateSourcePackageJson(packageJson)).toThrow(
      /must declare private=true/,
    );
    expect(() =>
      assertPrivateSourcePackageJson({ ...packageJson, private: false }),
    ).toThrow(/must declare private=true/);
  });

  it("publishes a compatible non-private root package lock", () => {
    const packageJson = createPackageJson();
    const packageLock = createPackageLock();

    expect(() =>
      assertPrivateSourcePackageLock(packageLock, packageJson),
    ).not.toThrow();
    const transformed = transformPublicPackageLock(packageLock, packageJson);
    expect(transformed).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
      packages: {
        "": {
          name: packageJson.name,
          version: packageJson.version,
          private: false,
        },
      },
    });
    expect(
      (packageLock.packages as Record<string, Record<string, unknown>>)[""]
        .private,
    ).toBe(true);
    expect(() =>
      transformPublicPackageLock(
        {
          ...packageLock,
          version: "9.9.9",
        },
        packageJson,
      ),
    ).toThrow(/name\/version must match package\.json/);
  });

  it("requires the exact approved plugin set in a public package", () => {
    const packagedPluginPaths = PUBLIC_PLUGIN_IDS.flatMap((pluginId) => [
      `plugins/${pluginId}/plugin.json`,
      `plugins/${pluginId}/src/index.cjs`,
    ]);

    expect(() =>
      assertExactPublicPluginPackagePaths(packagedPluginPaths),
    ).not.toThrow();
    expect(() =>
      assertExactPublicPluginPackagePaths(packagedPluginPaths.slice(2)),
    ).toThrow(/exactly the approved plugin set/);
    expect(() =>
      assertExactPublicPluginPackagePaths([
        ...packagedPluginPaths,
        "plugins/internal-canary/plugin.json",
      ]),
    ).toThrow(/exactly the approved plugin set/);
  });
});

describe("public snapshot builder and verifier", () => {
  it("keeps nested public sources visible while ignoring root runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "abot-public-gitignore-test-"));
    temporaryRoots.push(root);
    const nestedPublicPaths = [
      "plugins/code-outline/skills/code-outline/SKILL.md",
      "plugins/memory/src/index.cjs",
      "src/sessions/session-service.ts",
      "src/workspace/files.ts",
    ];
    const rootRuntimePaths = [
      "memory/checkpoint.json",
      "sessions/session.json",
      "skills/local/SKILL.md",
      "workspace/artifact.txt",
    ];

    await writeFixtureFile(
      root,
      ".gitignore",
      PUBLIC_ROOT_OVERLAYS[".gitignore"],
    );
    for (const relativePath of [...nestedPublicPaths, ...rootRuntimePaths]) {
      await writeFixtureFile(root, relativePath, "fixture\n");
    }
    await execFileAsync("git", ["-C", root, "init", "--quiet"]);
    await execFileAsync("git", ["-C", root, "add", "--all"]);

    const { stdout: trackedOutput } = await execFileAsync("git", [
      "-C",
      root,
      "ls-files",
    ]);
    const trackedPaths = trackedOutput.trim().split("\n");
    expect(trackedPaths).toEqual(expect.arrayContaining(nestedPublicPaths));
    for (const relativePath of rootRuntimePaths) {
      expect(trackedPaths).not.toContain(relativePath);
    }
  });

  it("builds deterministic snapshots and generates safe root overlays", async () => {
    const fixture = await createFixture();
    const outputA = join(fixture.parent, "public-a");
    const outputB = join(fixture.parent, "public-b");

    const recordA = await buildPublicSnapshot({
      sourceRoot: fixture.sourceRoot,
      outputRoot: outputA,
    });
    const recordB = await buildPublicSnapshot({
      sourceRoot: fixture.sourceRoot,
      outputRoot: outputB,
    });

    expect(recordA).toEqual(recordB);
    expect(recordA.treeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await readFile(join(outputA, PUBLIC_SNAPSHOT_FILE_NAME), "utf-8"),
    ).toBe(await readFile(join(outputB, PUBLIC_SNAPSHOT_FILE_NAME), "utf-8"));
    expect((await stat(join(outputA, "README.md"))).mode & 0o777).toBe(0o644);
    expect(
      (await stat(join(outputA, PUBLIC_SNAPSHOT_FILE_NAME))).mode & 0o777,
    ).toBe(0o644);
    expect(await readFile(join(outputA, ".env.example"), "utf-8")).toBe(
      PUBLIC_ROOT_OVERLAYS[".env.example"],
    );
    expect(await readFile(join(outputA, ".gitignore"), "utf-8")).toBe(
      PUBLIC_ROOT_OVERLAYS[".gitignore"],
    );
    const publicPackageLock = JSON.parse(
      await readFile(join(outputA, "package-lock.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(publicPackageLock).toMatchObject({
      name: "@fixture/public-runtime",
      version: "1.2.3",
      packages: {
        "": {
          name: "@fixture/public-runtime",
          version: "1.2.3",
          private: false,
        },
      },
    });
    expect(
      await readFile(join(outputA, ".env.example"), "utf-8"),
    ).not.toContain("INTERNAL_CANARY_TOKEN=internal-value");
    expect(await readFile(join(outputA, ".gitignore"), "utf-8")).not.toContain(
      "internal-canary",
    );
  });

  it("accepts an existing empty output directory", async () => {
    const fixture = await createFixture();
    const outputRoot = join(fixture.parent, "empty-output");
    await mkdir(outputRoot);

    await expect(
      buildPublicSnapshot({
        sourceRoot: fixture.sourceRoot,
        outputRoot,
      }),
    ).resolves.toMatchObject({ schemaVersion: PUBLIC_SNAPSHOT_SCHEMA_VERSION });
  });

  it("rejects output inside source and preserves a non-empty output", async () => {
    const fixture = await createFixture();

    await expect(
      buildPublicSnapshot({
        sourceRoot: fixture.sourceRoot,
        outputRoot: join(fixture.sourceRoot, "public"),
      }),
    ).rejects.toThrow(/outside the source root/);

    const outputRoot = join(fixture.parent, "non-empty");
    await mkdir(outputRoot);
    const sentinel = join(outputRoot, "keep-me.txt");
    await writeFile(sentinel, "keep\n", "utf-8");
    await expect(
      buildPublicSnapshot({
        sourceRoot: fixture.sourceRoot,
        outputRoot,
      }),
    ).rejects.toThrow(/must be empty/);
    expect(await readFile(sentinel, "utf-8")).toBe("keep\n");
  });

  it("rejects symlinked and non-regular allowed source files", async () => {
    const symlinkFixture = await createFixture();
    const linkedReadme = join(symlinkFixture.sourceRoot, "README.md");
    await rm(linkedReadme);
    await symlink(join(symlinkFixture.sourceRoot, "LICENSE"), linkedReadme);
    await commitFixture(symlinkFixture.sourceRoot, "symlink fixture");

    await expect(
      buildPublicSnapshot({
        sourceRoot: symlinkFixture.sourceRoot,
        outputRoot: join(symlinkFixture.parent, "symlink-output"),
      }),
    ).rejects.toThrow(/symlinks/);

    const fifoFixture = await createFixture();
    const fifoReadme = join(fifoFixture.sourceRoot, "README.md");
    await rm(fifoReadme);
    await execFileAsync("mkfifo", [fifoReadme]);
    await expect(
      buildPublicSnapshot({
        sourceRoot: fifoFixture.sourceRoot,
        outputRoot: join(fifoFixture.parent, "fifo-output"),
      }),
    ).rejects.toThrow(/worktree must be clean/);
  });

  it("requires the exact Git root, a clean tree, and tracked selected files", async () => {
    const fixture = await createFixture();
    await expect(
      buildPublicSnapshot({
        sourceRoot: join(fixture.sourceRoot, "src"),
        outputRoot: join(fixture.parent, "wrong-root"),
      }),
    ).rejects.toThrow(/exact Git root/);

    await execFileAsync("git", [
      "-C",
      fixture.sourceRoot,
      "rm",
      "--cached",
      "--quiet",
      "--",
      "src/runtime/__tests__/public-snapshot.test.ts",
    ]);
    await appendFile(
      join(fixture.sourceRoot, ".git/info/exclude"),
      "src/runtime/__tests__/public-snapshot.test.ts\n",
      "utf-8",
    );
    await execFileAsync("git", [
      "-C",
      fixture.sourceRoot,
      "commit",
      "--quiet",
      "--message",
      "remove explicit file from index",
    ]);
    await expect(
      buildPublicSnapshot({
        sourceRoot: fixture.sourceRoot,
        outputRoot: join(fixture.parent, "explicit-untracked-output"),
      }),
    ).rejects.toThrow(/must be Git-tracked/);

    await writeFixtureFile(
      fixture.sourceRoot,
      "src/untracked-canary.ts",
      "export const canary = true;\n",
    );
    await expect(
      buildPublicSnapshot({
        sourceRoot: fixture.sourceRoot,
        outputRoot: join(fixture.parent, "untracked-output"),
      }),
    ).rejects.toThrow(/worktree must be clean/);
  });

  it("applies generic and build-only local content checks", async () => {
    const pathFixture = await createFixture();
    await writeFixtureFile(
      pathFixture.sourceRoot,
      "README.md",
      ["/home", "sample-user", "project"].join("/") + "\n",
    );
    await commitFixture(pathFixture.sourceRoot, "machine path fixture");
    await expect(
      buildPublicSnapshot({
        sourceRoot: pathFixture.sourceRoot,
        outputRoot: join(pathFixture.parent, "path-output"),
      }),
    ).rejects.toThrow(/machine-specific path/);

    const denylistFixture = await createFixture();
    await writeFixtureFile(
      denylistFixture.sourceRoot,
      ".publication-denylist.local",
      "fixture: README.md\n",
    );
    await appendFile(
      join(denylistFixture.sourceRoot, ".git/info/exclude"),
      ".publication-denylist.local\n",
      "utf-8",
    );
    await expect(
      buildPublicSnapshot({
        sourceRoot: denylistFixture.sourceRoot,
        outputRoot: join(denylistFixture.parent, "denylist-output"),
      }),
    ).rejects.toThrow(/denylist term/);
  });

  it("rejects globally routable IPv4 literals while accepting SSRF policy ranges", async () => {
    const publicAddressFixture = await createFixture();
    const publicAddress = [93, 184, 216, 34].join(".");
    await writeFixtureFile(
      publicAddressFixture.sourceRoot,
      "src/public-endpoint.ts",
      `export const endpoint = "http://${publicAddress}/";\n`,
    );
    await commitFixture(
      publicAddressFixture.sourceRoot,
      "public address fixture",
    );
    await expect(
      buildPublicSnapshot({
        sourceRoot: publicAddressFixture.sourceRoot,
        outputRoot: join(publicAddressFixture.parent, "public-address-output"),
      }),
    ).rejects.toThrow(
      /hardcoded globally routable IPv4 address: src\/public-endpoint\.ts/u,
    );

    const specialUseFixture = await createFixture();
    const policyBases = [
      "0.0.0.0",
      "10.0.0.0",
      "100.64.0.0",
      "127.0.0.0",
      "169.254.0.0",
      "172.16.0.0",
      "192.0.0.0",
      "192.0.2.0",
      "192.88.99.0",
      "192.168.0.0",
      "198.18.0.0",
      "198.51.100.0",
      "203.0.113.0",
      "224.0.0.0",
      "240.0.0.0",
    ];
    await writeFixtureFile(
      specialUseFixture.sourceRoot,
      "src/ssrf-policy.ts",
      `export const policyBases = ${JSON.stringify(policyBases)};\n`,
    );
    await commitFixture(specialUseFixture.sourceRoot, "SSRF policy fixture");
    await expect(
      buildPublicSnapshot({
        sourceRoot: specialUseFixture.sourceRoot,
        outputRoot: join(specialUseFixture.parent, "special-use-output"),
      }),
    ).resolves.toMatchObject({
      schemaVersion: PUBLIC_SNAPSHOT_SCHEMA_VERSION,
    });
  });

  it("scans untracked selected files during private readiness checks", async () => {
    const fixture = await createFixture();
    await writeFixtureFile(
      fixture.sourceRoot,
      ".env.example",
      "OPENAI_API_KEY=\n",
    );
    const publicAddress = [8, 8, 8, 8].join(".");
    await writeFixtureFile(
      fixture.sourceRoot,
      "src/untracked-public-endpoint.ts",
      `export const endpoint = "http://${publicAddress}/";\n`,
    );

    const checkerPath = join(
      process.cwd(),
      "scripts/check-publication-readiness.ts",
    );
    const tsxPath = join(process.cwd(), "node_modules/.bin/tsx");
    await expect(
      execFileAsync(tsxPath, [checkerPath], { cwd: fixture.sourceRoot }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "hardcoded globally routable IPv4 address: src/untracked-public-endpoint.ts",
      ),
    });
  });

  it("detects tampered and extra snapshot files", async () => {
    const tamperedFixture = await createFixture();
    const tamperedOutput = join(tamperedFixture.parent, "tampered");
    await buildPublicSnapshot({
      sourceRoot: tamperedFixture.sourceRoot,
      outputRoot: tamperedOutput,
    });
    await appendFile(join(tamperedOutput, "README.md"), "tampered\n", "utf-8");
    await expect(
      verifyPublicSnapshot({
        outputRoot: tamperedOutput,
      }),
    ).rejects.toThrow(/integrity verification/);

    const extraFixture = await createFixture();
    const extraOutput = join(extraFixture.parent, "extra");
    await buildPublicSnapshot({
      sourceRoot: extraFixture.sourceRoot,
      outputRoot: extraOutput,
    });
    for (const generatedDirectory of [".git", ".runtime", "coverage", "dist", "node_modules"]) {
      await writeFixtureFile(
        extraOutput,
        `${generatedDirectory}/generated.txt`,
        "generated\n",
      );
    }
    await expect(
      verifyPublicSnapshot({
        outputRoot: extraOutput,
      }),
    ).resolves.toMatchObject({ schemaVersion: PUBLIC_SNAPSHOT_SCHEMA_VERSION });
    await writeFixtureFile(extraOutput, "src/.runtime/unexpected.txt", "extra\n");
    await expect(
      verifyPublicSnapshot({
        outputRoot: extraOutput,
      }),
    ).rejects.toThrow(/positive allowlist/);
  });

  it("keeps publication metadata checks separate from the frozen receipt", async () => {
    const fixture = await createFixture();
    const outputRoot = join(fixture.parent, "maintainable-public");
    await buildPublicSnapshot({
      sourceRoot: fixture.sourceRoot,
      outputRoot,
    });
    await appendFile(join(outputRoot, "README.md"), "public change\n", "utf-8");

    const checkerPath = join(
      process.cwd(),
      "scripts/check-publication-readiness.ts",
    );
    const tsxPath = join(process.cwd(), "node_modules/.bin/tsx");
    await expect(
      execFileAsync(tsxPath, [checkerPath], { cwd: outputRoot }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining("readiness ok"),
    });

    await rm(
      join(outputRoot, "docs/tool-execution-result-evidence-contract.md"),
    );
    await expect(
      execFileAsync(tsxPath, [checkerPath], { cwd: outputRoot }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "required publication file is missing: docs/tool-execution-result-evidence-contract.md",
      ),
    });
  });
});
