import { expect, test, vi } from "vitest";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { privateRoot, serverSettings } from "./fixtures.js";
import { createServerPresets } from "../presets.js";
import { spawnServerTree, signalServerTree, serverProcessEnvironment } from "../process-tree.js";

test("Windows wrapper environment uses the validated run directory for compilation and excludes inherited secrets", () => {
  const cache = "C:\\ABot data\\.server-run-fixture";
  const env = serverProcessEnvironment("synthetic-key", cache, "win32", {
    SystemRoot: "C:\\Windows", TEMP: "C:\\untrusted", TMP: "C:\\untrusted", USERPROFILE: "C:\\Users\\fixture", OPENAI_API_KEY: "private", NODE_OPTIONS: "--inspect" });
  expect(env).toEqual({ SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", LLAMA_API_KEY: "synthetic-key", LLAMA_CACHE: cache, TMP: cache, TEMP: cache });
  expect(serverProcessEnvironment("key", "/private/run", "darwin")).not.toHaveProperty("TEMP");
});

// Native process fixture only: Node children, no llama binary, model or socket.
test.each(["stop", "parent-exit"])("owned process tree terminates descendants on %s", async action => {
  const root = await privateRoot(), receipt = join(root, "pids.json");
  const presets = await createServerPresets(root, serverSettings(root));
  const script = `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`;
  const child = spawnServerTree(process.execPath, ["-e", script], { shell: false, detached: false, stdio: "ignore", env: serverProcessEnvironment("fixture-key", presets.cache) });
  const exited = once(child, "exit");
  let pids: number[] = [];
  try {
    await vi.waitFor(async () => { pids = JSON.parse(await readFile(receipt, "utf8")); expect(pids).toHaveLength(2); }, { timeout: 20_000, interval: 25 });
    if (action === "stop") signalServerTree(child, "SIGTERM");
    else process.kill(pids[0]!, "SIGKILL");
    await exited;
    await vi.waitFor(() => { for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 5000, interval: 25 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) signalServerTree(child, "SIGKILL");
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* Owned fixture already exited. */ } }
    await exited; await presets.remove(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
