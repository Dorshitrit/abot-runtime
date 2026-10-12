import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createLocalSystemCommandOutput } from "../../../plugins/system/source/local-command-output.js";
import type { RuntimePluginLoadContext } from "../../plugin-sdk/index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const parent = join(process.cwd(), ".codex/artifacts/secret-protection-contract-20261010/local-output");
  await mkdir(parent, { recursive: true });
  const stateDir = await mkdtemp(join(parent, "case-")); roots.push(stateDir);
  const output = createLocalSystemCommandOutput({ stateDir, config: {} } as RuntimePluginLoadContext)();
  return { stateDir, output };
}

test("local output uses the independent plugin detector before admitted output and result excerpts", async () => {
  const f = await fixture();
  const result = await f.output.run({ executable: process.execPath,
    args: ["-e", 'process.stdout.write("api_key=synthetic-out"); process.stderr.write("password=synthetic-err"); process.exitCode = 9;'] });
  const delivered = await f.output.present({ id: "linux", transport: "native", shell: "/bin/bash" }, result);
  expect(delivered).toMatchObject({ ok: false, exitCode: 9, errorCode: "system_command_failed", stdout: "[REDACTED]", stderr: "[REDACTED]" });
  expect(JSON.stringify(delivered)).not.toContain("synthetic-");
  const directory = join(f.stateDir, "command-output", (await readdir(join(f.stateDir, "command-output")))[0]!);
  expect(await readFile(join(directory, "stdout.bytes"), "utf8")).toBe("[REDACTED]");
  expect(await readFile(join(directory, "stderr.bytes"), "utf8")).toBe("[REDACTED]");
});

test("spawn errors cannot reintroduce raw stderr or executable identity through the capture fallback", async () => {
  const f = await fixture();
  const result = await f.output.run({ executable: "/missing/api_key=synthetic-error", args: [] });
  const delivered = await f.output.present({ id: "linux", transport: "native", shell: "/bin/bash" }, result);
  expect(result.stderr).toBe("");
  expect(delivered).toMatchObject({ ok: false, data: { processStatus: "spawn_failed", outputCapture: { complete: false } } });
  expect(JSON.stringify(delivered)).not.toContain("synthetic-error");
});
