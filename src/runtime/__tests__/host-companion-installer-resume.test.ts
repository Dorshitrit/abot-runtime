import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { renderMacCompanionScript } from "../../web-ui/system-host-setup/companion-macos.js";
import { COMPANION_NODE_VERSION } from "../../web-ui/system-host-setup/node-distribution.js";

const directories: string[] = [];
const bundleContent =
  "// fixture companion; the Node shim captures setup instead of executing it\n";
const metadata = {
  platform: "macos" as const,
  url: "http://abot-qa.localhost:5184",
  code: "a".repeat(43),
  bundleSha256: createHash("sha256").update(bundleContent).digest("hex"),
  expiresAt: "2000-01-01T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function cachedInstallation(
  options: { nodeVersion?: string; setupExitCode?: number } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "abot-installer-resume-"));
  directories.push(directory);
  const base = join(
    directory,
    "Library/Application Support/ABot/HostCompanion",
  );
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const node = join(
    base,
    `node-${COMPANION_NODE_VERSION}-darwin-${architecture}`,
    "bin/node",
  );
  const bundle = join(base, `companion-${metadata.bundleSha256}.mjs`);
  const connection = join(directory, ".abot/host-companion/connection.json");
  await mkdir(join(node, ".."), { recursive: true });
  await mkdir(join(connection, ".."), { recursive: true });
  await writeFile(
    connection,
    '{"fixture":"saved pairing must stay unchanged"}\n',
  );
  await writeFile(bundle, bundleContent);
  await writeFile(
    node,
    `#!/bin/bash
if [ "\${1:-}" = '--version' ]; then
  printf '%s\\n' '${options.nodeVersion ?? COMPANION_NODE_VERSION}'
  exit 0
fi
printf '%s\\n' "$@" > "$HOME/setup-arguments"
/bin/cat > "$HOME/setup-payload.json"
exit ${options.setupExitCode ?? 0}
`,
    { mode: 0o700 },
  );
  return { directory, base, node, bundle, connection };
}

function runInstaller(
  directory: string,
  input = metadata,
  downloadShim?: string,
) {
  let script = renderMacCompanionScript(input);
  if (downloadShim)
    script = script.replaceAll("/usr/bin/curl", `"${downloadShim}"`);
  return spawnSync("/bin/bash", [], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, HOME: directory },
    timeout: 5_000,
  });
}

test("an expired installer resumes verified cached setup without downloading or changing the saved pairing", async () => {
  const fixture = await cachedInstallation();
  const saved = await readFile(fixture.connection, "utf8");
  const result = runInstaller(fixture.directory);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain("Downloading");
  expect(
    JSON.parse(
      await readFile(join(fixture.directory, "setup-payload.json"), "utf8"),
    ),
  ).toEqual({ url: metadata.url, code: metadata.code });
  expect(
    await readFile(join(fixture.directory, "setup-arguments"), "utf8"),
  ).toBe(`${fixture.bundle}\nsetup\n`);
  expect(await readFile(fixture.connection, "utf8")).toBe(saved);
  expect(
    (await readdir(fixture.base)).some((entry) => entry.startsWith("setup.")),
  ).toBe(false);
});

test.each(["node", "bundle"] as const)(
  "expired setup with missing cached %s requires a fresh invitation before downloads",
  async (missing) => {
    const fixture = await cachedInstallation();
    await rm(fixture[missing]);
    const result = runInstaller(fixture.directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invitation expired");
    expect(result.stdout).not.toContain("Downloading");
    await expect(
      readFile(join(fixture.directory, "setup-payload.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("a fresh invitation downloads the new exact bundle while preserving the previous pairing and cached build", async () => {
  const fixture = await cachedInstallation();
  const saved = await readFile(fixture.connection, "utf8");
  const nextContent = `${bundleContent}// upgraded build\n`;
  const next = {
    ...metadata,
    bundleSha256: createHash("sha256").update(nextContent).digest("hex"),
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const download = join(fixture.directory, "download-fixture");
  await writeFile(download, nextContent);
  const shim = join(fixture.directory, "curl-fixture");
  await writeFile(
    shim,
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" > "$HOME/download-arguments"
/bin/cat > "$HOME/download-authorization"
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--output' ]; then destination="$2"; shift; fi
  shift
done
/bin/cp "$HOME/download-fixture" "$destination"
`,
    { mode: 0o700 },
  );
  const result = runInstaller(fixture.directory, next, shim);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    "Downloading and verifying the ABot companion",
  );
  const nextBundle = join(fixture.base, `companion-${next.bundleSha256}.mjs`);
  expect(await readFile(nextBundle, "utf8")).toBe(nextContent);
  expect(await readFile(fixture.bundle, "utf8")).toBe(bundleContent);
  expect(await readFile(fixture.connection, "utf8")).toBe(saved);
  expect(
    await readFile(join(fixture.directory, "setup-arguments"), "utf8"),
  ).toBe(`${nextBundle}\nsetup\n`);
  expect(
    await readFile(join(fixture.directory, "download-arguments"), "utf8"),
  ).toContain(`${metadata.url}/web-api/runtime/system-host/bundle`);
  expect(
    await readFile(join(fixture.directory, "download-authorization"), "utf8"),
  ).toContain(`Authorization: Bearer ${metadata.code}`);
});

test("resume rejects a modified cached bundle before executing setup", async () => {
  const fixture = await cachedInstallation();
  await writeFile(fixture.bundle, "modified bundle");
  const result = runInstaller(fixture.directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("checksum");
  await expect(
    readFile(join(fixture.directory, "setup-payload.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("resume rejects a cached Node version that differs from the installer metadata", async () => {
  const fixture = await cachedInstallation({ nodeVersion: "v0.0.0" });
  const result = runInstaller(fixture.directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Node.js runtime could not be verified");
  await expect(
    readFile(join(fixture.directory, "setup-payload.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("resume propagates the CLI refusal and leaves saved connection data untouched", async () => {
  const fixture = await cachedInstallation({ setupExitCode: 7 });
  const saved = await readFile(fixture.connection, "utf8");
  const result = runInstaller(fixture.directory);
  expect(result.status).toBe(7);
  expect(result.stdout).not.toContain("setup completed");
  expect(await readFile(fixture.connection, "utf8")).toBe(saved);
});

test("cached files without saved pairing do not bypass invitation expiry", async () => {
  const fixture = await cachedInstallation();
  await rm(fixture.connection);
  const result = runInstaller(fixture.directory);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("invitation expired");
  await expect(
    readFile(join(fixture.directory, "setup-payload.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
