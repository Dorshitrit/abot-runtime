import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createSystemHandlers } from "../../computer-access/handlers.js";
import { resolveSystemTarget, powershellLiteral } from "../../computer-access/targets.js";
import { createLocalSystemCommandOutput } from "../../../plugins/system/source/local-command-output.js";
import { systemResultProtection } from "../../../plugins/system/source/security/system-results.js";
import type { RuntimePluginLoadContext } from "../../plugin-sdk/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(withCommandOutput = true) {
  const parent = join(process.cwd(), ".codex/artifacts/windows-public-plugins/system-commands");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-")); roots.push(root);
  const target = await resolveSystemTarget("windows");
  expect(target).toMatchObject({ id: "windows", transport: "native" });
  const output = withCommandOutput
    ? createLocalSystemCommandOutput({ stateDir: root, config: {} } as RuntimePluginLoadContext)
    : undefined;
  const handlers = createSystemHandlers(undefined, async () => target, output, systemResultProtection);
  return { root, command: handlers.system_command!, handlers };
}

test.skipIf(process.platform !== "win32")("native PowerShell retains cwd, Unicode and exit receipt and protects full output without replay", async () => {
  const f = await fixture();
  const marker = join(f.root, "dispatch-count");
  const receipt = await f.command({ target: "windows", cwd: f.root,
    command: `[IO.File]::AppendAllText(${powershellLiteral(marker)}, '1'); [Console]::Out.Write('api_key=synthetic-windows-secret'); [Console]::Error.Write('ordinary Ω'); exit 7` });
  expect(receipt).toMatchObject({ ok: false, errorCode: "system_command_failed", exitCode: 7,
    stdout: "[REDACTED]", stderr: expect.stringContaining("ordinary Ω"), data: { target: "windows", transport: "native", processStatus: "completed",
      spawnedProcess: { pid: expect.any(Number), pidNamespace: "runtime_os" } } });
  expect(JSON.stringify(receipt)).not.toContain("synthetic-windows-secret");
  expect(await readFile(marker, "utf8")).toBe("1");
  const clean = await f.command({ target: "windows", cwd: f.root, command: "[Console]::Out.Write((Get-Location).Path)" });
  expect(clean).toMatchObject({ ok: true, stdout: f.root, exitCode: 0 });
  expect(await readFile(marker, "utf8")).toBe("1");
}, 45_000);

test.skipIf(process.platform !== "win32")("cancelling an active native command retains its receipt and never dispatches it again", async () => {
  const f = await fixture();
  const marker = join(f.root, "started");
  const controller = new AbortController();
  const pending = f.command({ target: "windows", cwd: f.root,
    command: `[IO.File]::AppendAllText(${powershellLiteral(marker)}, '1'); [Console]::Out.Write('password=synthetic-cancel-secret'); Start-Sleep -Seconds 30` },
    { abortSignal: controller.signal });
  try {
    await vi.waitFor(async () => expect((await stat(marker)).isFile()).toBe(true), { timeout: 15_000, interval: 50 });
    controller.abort();
    const receipt = await pending;
    expect(receipt.ok).toBe(false);
    expect(receipt.data).toMatchObject({ processStatus: "aborted", target: "windows", transport: "native",
      spawnedProcess: { pid: expect.any(Number), pidNamespace: "runtime_os" } });
    expect(JSON.stringify(receipt)).not.toContain("synthetic-cancel-secret");
    expect(await readFile(marker, "utf8")).toBe("1");
  } finally { controller.abort(); await pending; }
}, 45_000);


test.skipIf(process.platform !== "win32")("native Start catalog discovery stays scoped and rejects an unobserved identity without launching", async () => {
  const f = await fixture(false);
  const absent = "ABOT_QA_UNOBSERVED_" + randomUUID();
  const discovery = await f.handlers.system_applications!({ target: "windows", query: absent });
  expect(discovery.ok).toBe(true);
  expect(discovery.data).toMatchObject({ target: "windows", transport: "native", applications: [],
    observedMatches: 0, absenceConclusionSupported: false, catalogScope: { source: "windows_start_apps" } });
  const refusal = await f.handlers.system_launch!({ target: "windows", application_id: absent });
  expect(refusal).toMatchObject({ ok: false, errorCode: "system_application_not_found" });
}, 45_000);
