import { execFileSync } from "node:child_process";
import JSZip from "jszip";
import { describe, expect, test } from "vitest";
import { InstallerInputError, renderCompanionInstaller, renderWslInteropInstaller } from "../../web-ui/system-host-setup/installers.js";
import { COMPANION_NODE_DISTRIBUTIONS } from "../../web-ui/system-host-setup/node-distribution.js";

const input = {
  platform: "windows" as const,
  url: "http://abot-qa.localhost:5184",
  code: "a".repeat(43),
  bundleSha256: "b".repeat(64),
  expiresAt: "2099-01-01T00:00:00.000Z",
};
function windowsBody(contentBase64: string) {
  const text = Buffer.from(contentBase64, "base64").toString("utf8");
  const marker = "#==ABOT-POWERSHELL==";
  const boundary = text.lastIndexOf(marker);
  return { header: text.slice(0, boundary), body: text.slice(boundary + marker.length) };
}

describe("downloaded host companion setup", () => {
  test("Windows metadata stays in the file body and retains exact pairing and bundle bindings", async () => {
    const result = await renderCompanionInstaller(input);
    expect(result.filename).toMatch(/\.cmd$/u);
    const { body, header } = windowsBody(result.contentBase64);
    const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(body)![1]!;
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toMatchObject(input);
    expect(header).not.toContain(input.code);
    expect(header).not.toContain(encoded);
    expect(header).toContain('"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"');
    expect(header).not.toMatch(/ExecutionPolicy|EncodedCommand/iu);
    expect(body).toContain("$Payload | & $Node $Bundle setup");
    expect(body).not.toContain("& $Node $Bundle setup $Metadata.code");
    expect(body).toContain("$Request.Host = $Original.Authority");
    expect(body).toContain("$Builder.Host = '127.0.0.1'");
    expect(body).toContain("$Request.AllowAutoRedirect = $false");
  });

  test("Mac download contains an executable command file and parses without running setup", async () => {
    const result = await renderCompanionInstaller({ ...input, platform: "macos" });
    expect(result.filename).toMatch(/\.zip$/u);
    const zip = await JSZip.loadAsync(result.contentBase64, { base64: true });
    const entries = Object.values(zip.files);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.name).toBe("ABot-Connect-Computer.command");
    expect(Number(entry.unixPermissions) & 0o777).toBe(0o755);
    const script = await entry.async("string");
    execFileSync("/bin/bash", ["-n"], { input: script });
    expect(script).toContain("--resolve 'abot-qa.localhost:5184:127.0.0.1'");
    expect(script).toContain("curl --config -");
    expect(script).not.toContain("--header");
    expect(script).toContain(`companion-${input.bundleSha256}.mjs`);
    expect(script).toContain('"$NODE" "$BUNDLE" setup');
  });

  test.each([
    "https://localhost:5184", "http://attacker.example", "http://localhost@attacker.example",
    "http://localhost:5184/path", "http://localhost:5184/?code=injected", "http://localhost:5184/#fragment",
    "http://local\nhost:5184", "file:///tmp/runtime",
  ])("rejects unsafe or unsupported origin %s before generating an executable", async (url) => {
    await expect(renderCompanionInstaller({ ...input, url })).rejects.toBeInstanceOf(InstallerInputError);
  });

  test.each(["http://localhost:5184", "http://127.0.0.1:5184", "http://[::1]:5184"])("accepts explicit loopback origin %s", async (url) => {
    expect((await renderCompanionInstaller({ ...input, url })).filename).toMatch(/\.cmd$/u);
  });

  test.each([
    { code: "x\nInjected-Command" }, { code: "x'$(anything)" },
    { bundleSha256: "sha;command" }, { expiresAt: "not-a-date" },
  ])("rejects malformed executable metadata %j", async (change) => {
    await expect(renderCompanionInstaller({ ...input, ...change })).rejects.toBeInstanceOf(InstallerInputError);
  });

  test("all supported Node archives have separate pinned SHA256 values", () => {
    expect(Object.keys(COMPANION_NODE_DISTRIBUTIONS)).toEqual(["win-x64", "win-arm64", "darwin-x64", "darwin-arm64"]);
    const hashes = Object.values(COMPANION_NODE_DISTRIBUTIONS).map((distribution) => distribution.sha256);
    expect(new Set(hashes).size).toBe(4);
    for (const hash of hashes) expect(hash).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("downloaded WSL repair selection", () => {
  test.each([undefined, "Ubuntu-24.04", "Owner Ubuntu"])("binds optional distribution %s as data", async (distribution) => {
    const result = await renderWslInteropInstaller({ distribution });
    const { body } = windowsBody(result.contentBase64);
    const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(body)![1]!;
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual(distribution ? { distribution } : {});
    expect(body).not.toContain("--shutdown");
    expect(body).toContain("--terminate $Selected");
    expect(body).toContain("-ccontains $Selected");
  });

  test.each(["docker-desktop", "docker-desktop-data", "-Ubuntu", "Ubuntu\ncommand", "Ubuntu'; Remove-Item x", "x".repeat(129)])("rejects distribution injection/internal target %s", async (distribution) => {
    await expect(renderWslInteropInstaller({ distribution })).rejects.toBeInstanceOf(InstallerInputError);
  });
});
