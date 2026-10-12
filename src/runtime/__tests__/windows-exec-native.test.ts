import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, test } from "vitest";
import createExec from "../../../plugins/exec/source/index.js";
import type { RuntimePluginEntrypointFactory } from "../../plugin-contract/entrypoint.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

const require = createRequire(import.meta.url);
afterEach(removePortablePluginFixtures);

async function fixture(bundled: boolean, yieldAfterMs = 20_000) {
  const context = await createPortablePluginFixture("exec");
  await mkdir(context.runtimePaths.agentWorkDir, { recursive: true });
  await mkdir(context.runtimePaths.workspaceDir, { recursive: true });
  const create = bundled
    ? (require(join(process.cwd(), "plugins/exec/src/index.cjs"))
        .default as RuntimePluginEntrypointFactory)
    : createExec;
  return {
    context,
    handlers: create({
      ...context,
      config: { timeoutMs: 30_000, idleTimeoutMs: 20_000, yieldAfterMs },
    }).handlers,
  };
}

const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

describe.skipIf(process.platform !== "win32")("native Windows EXEC", () => {
  test.each([false, true])(
    "writes in the filesystem root and preserves multiline Unicode (bundle=%s)",
    async (bundled) => {
      const { context, handlers } = await fixture(bundled);
      const text = "שלום 🙂\nsecond line $literal";
      const command =
        "$text=@'\n" +
        text +
        "\n'@\n[IO.File]::WriteAllText((Join-Path (Get-Location) 'result.txt'),$text)\n[Console]::Write($text)";
      const result = await handlers.exec!({ command, cwd: "." });
      expect(result).toMatchObject({ ok: true, exitCode: 0, stdout: text });
      expect(
        await readFile(
          join(context.runtimePaths.agentWorkDir, "result.txt"),
          "utf8",
        ),
      ).toBe(text);
      expect(result.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: "result.txt" }),
        ]),
      );
    },
    40_000,
  );

  test.each([false, true])(
    "uses workspace aliases and preserves native exit codes (bundle=%s)",
    async (bundled) => {
      const { context, handlers } = await fixture(bundled);
      const directory = join(context.runtimePaths.workspaceDir, "folder שלום");
      await mkdir(directory);
      const command =
        "[IO.File]::WriteAllText((Join-Path (Get-Location) 'marker.txt'),'yes'); & " +
        quote(process.execPath) +
        " -e 'process.exit(7)'";
      expect(
        await handlers.exec!({ command, cwd: "workspace\\folder שלום" }),
      ).toMatchObject({ ok: false, exitCode: 7, errorCode: "non_zero_exit" });
      expect(await readFile(join(directory, "marker.txt"), "utf8")).toBe("yes");
    },
    40_000,
  );

  test("keeps output intact and accepts the full 8192-character command", async () => {
    const { handlers } = await fixture(true);
    const command = "[Console]::Write(('א🙂' * 30000))\n#".padEnd(8192, "x");
    const result = await handlers.exec!({ command, cwd: "." });
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: "א🙂".repeat(30000),
    });
  }, 40_000);

  test("restores module discovery before running the supplied command", async () => {
    const previous = process.env.PSModulePath;
    const { context, handlers } = await fixture(true);
    const customModules = join(context.rootDir, "user modules");
    await mkdir(customModules);
    process.env.PSModulePath = [customModules, previous]
      .filter(Boolean)
      .join(";");
    try {
      const result = await handlers.exec!({
        command: "[Console]::Write($env:PSModulePath)",
        cwd: ".",
      });
      expect(result).toMatchObject({ ok: true, exitCode: 0 });
      expect(String(result.stdout).split(";")).toContain(customModules);
    } finally {
      if (previous === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = previous;
    }
  }, 40_000);

  test("waits on the same process without replaying its command", async () => {
    const { context, handlers } = await fixture(true, 200);
    const execution = {
      sharedState: { currentSessionId: "windows-exec-owner" },
    };
    const command =
      "[IO.File]::AppendAllText((Join-Path (Get-Location) 'once.txt'),'1');[Console]::Write('begin');Start-Sleep -Seconds 1;[Console]::Write('end')";
    let result = await handlers.exec!({ command, cwd: "." }, execution);
    const parts = [result.stdout ?? ""];
    expect(result.errorCode).toBe("exec_process_running");
    const id = result.data!.processId;
    for (
      let n = 0;
      n < 100 && result.errorCode === "exec_process_running";
      n++
    ) {
      result = await handlers.exec_wait!(
        { process_id: id, cursor: result.data!.nextCursor },
        execution,
      );
      parts.push(result.stdout ?? "");
    }
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(parts.join("")).toBe("beginend");
    expect(
      await readFile(
        join(context.runtimePaths.agentWorkDir, "once.txt"),
        "utf8",
      ),
    ).toBe("1");
  }, 40_000);
});
