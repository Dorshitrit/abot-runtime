import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

const executeFile = promisify(execFile);
const fixtures: string[] = [];
afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const parent = join(process.cwd(), ".codex/artifacts/pr185-windows-private-access/fixtures");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "root-"));
  fixtures.push(root);
  const modules = join(root, "modules");
  const security = join(modules, "Microsoft.PowerShell.Security");
  await mkdir(security, { recursive: true });
  await writeFile(join(security, "Microsoft.PowerShell.Security.psd1"), [
    "@{", "ModuleVersion = '99.0.0'", "RequiredAssemblies = @('wrong_security_module_loaded.dll')",
    "FunctionsToExport = @('Get-Acl', 'Set-Acl')", "}",
  ].join("\n"));
  // Windows environment keys are case insensitive; the test runner may expose both casings.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  return { root, target: join(root, "private"), env: { ...inherited,
    PSModulePath: modules + ";" + (process.env.PSModulePath ?? ""),
  } };
}

function powershell(script: string, env: NodeJS.ProcessEnv) {
  return executeFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { env, windowsHide: true, timeout: 10_000, maxBuffer: 16_384 });
}

function runPrivateAccess(path: string, env: NodeJS.ProcessEnv, create = true) {
  const directoryModule = pathToFileURL(join(process.cwd(), "src/runtime/local-host/private-directory.ts")).href;
  const accessModule = pathToFileURL(join(process.cwd(), "src/runtime/local-host/windows-private-access.ts")).href;
  const script = [
    "import { ensurePrivateRuntimeDirectory } from " + JSON.stringify(directoryModule) + ";",
    "import { verifyWindowsPrivateAccess } from " + JSON.stringify(accessModule) + ";",
    "try {",
    'if (process.argv[2] === "create") await ensurePrivateRuntimeDirectory(process.argv[1]);',
    "await verifyWindowsPrivateAccess(process.argv[1]);",
    "console.log(JSON.stringify({ modulePath: process.env.PSModulePath }));",
    "} catch (error) {",
    'console.error("HELPER_FAILURE:" + (typeof error.code === "number" ? error.code : error.message));',
    "process.exitCode = 1;",
    "}",
  ].join("\n");
  return executeFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script,
    path, create ? "create" : "verify"], { env, windowsHide: true, timeout: 25_000, maxBuffer: 16_384 });
}

test.skipIf(process.platform !== "win32")("private ACL setup ignores inherited incompatible modules without changing its Node environment", async () => {
  const f = await fixture();
  const parentPath = process.env.PSModulePath;
  await expect(powershell("try { $ErrorActionPreference='Stop'; Import-Module Microsoft.PowerShell.Security -Force } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }", f.env))
    .rejects.toMatchObject({ stderr: expect.stringContaining("wrong_security_module_loaded") });
  const result = await runPrivateAccess(f.target, f.env);
  expect(JSON.parse(result.stdout)).toEqual({ modulePath: f.env.PSModulePath });
  expect(process.env.PSModulePath).toBe(parentPath);
}, 30_000);

test.skipIf(process.platform !== "win32")("private ACL validation still rejects access granted to other Windows users", async () => {
  const f = await fixture();
  await runPrivateAccess(f.target, f.env);
  // Change only this empty fixture's DACL; Get-Acl/Set-Acl may also try to write its SACL.
  await executeFile("icacls.exe", [f.target, "/grant", "*S-1-5-32-545:(OI)(CI)RX"], {
    windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
  });
  await expect(runPrivateAccess(f.target, f.env, false))
    .rejects.toMatchObject({ stderr: expect.stringContaining("HELPER_FAILURE:4") });
}, 30_000);

test.skipIf(process.platform !== "win32")("private directory setup still rejects an existing file", async () => {
  const f = await fixture();
  await writeFile(f.target, "fixture");
  await expect(runPrivateAccess(f.target, f.env))
    .rejects.toMatchObject({ stderr: expect.stringContaining("HELPER_FAILURE:local_runtime_directory_not_private") });
}, 30_000);
