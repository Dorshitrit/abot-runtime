import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { runWindowsFilesystem } from "../../../plugins/filesystem/source/windows/process.js";

function responseProcess(body: string): typeof spawn {
  return ((_executable: string, _args: string[], options: object) =>
    spawn(process.execPath, ["-e", body], options)) as typeof spawn;
}

describe("Windows filesystem helper transport", () => {
  test.each(["read", "write"])("explains a directory type conflict during %s", async (operation) => {
    await expect(runWindowsFilesystem(
      { operation }, undefined,
      responseProcess('process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(\'{"ok":false,"code":"not_a_directory"}\'));'),
    )).rejects.toMatchObject({
      code: "not_a_directory",
      message: expect.stringContaining("An existing file cannot contain child files."),
    });
  });

  test.each([
    "filesystem_windows_policy_blocked",
    "filesystem_windows_helper_unavailable",
  ])("reports %s as a non-retryable block before file work", async (code) => {
    await expect(
      runWindowsFilesystem(
        { operation: "write" },
        undefined,
        responseProcess(
          "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(" +
            JSON.stringify(JSON.stringify({ ok: false, code })) +
            "));",
        ),
      ),
    ).rejects.toMatchObject({
      code,
      data: { retryable: false, operationOutcome: "not_started" },
    });
  });

  test.each([
    ["filesystem_storage_attributes_unsupported", "file_storage_attributes"],
    ["filesystem_named_streams_unsupported", "file_named_streams"],
    [
      "filesystem_windows_publication_unsupported",
      "filesystem_publication_support",
    ],
  ])(
    "%s reports an unchanged target and forbids retries",
    async (code, blockedBy) => {
      await expect(
        runWindowsFilesystem(
          { operation: "write" },
          undefined,
          responseProcess(
            "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(" +
              JSON.stringify(JSON.stringify({ ok: false, code })) +
              "));",
          ),
        ),
      ).rejects.toMatchObject({
        code,
        data: {
          retryable: false,
          blockedBy,
          targetUnchanged: true,
        },
      });
    },
  );

  test("unreported write outcomes are unknown and native diagnostics are not exposed", async () => {
    const result = runWindowsFilesystem(
      { operation: "write" },
      undefined,
      responseProcess(
        "process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write('private diagnostic'); process.stdout.write('invalid result'); });",
      ),
    );
    await expect(result).rejects.toMatchObject({
      code: "filesystem_windows_response_invalid",
      data: { retryable: false, operationOutcome: "unknown" },
    });
    await expect(result).rejects.not.toThrow("private diagnostic");
  });

  test("an absent helper is unavailable without claiming a write occurred", async () => {
    const missing: typeof spawn = ((
      _file: string,
      _args: string[],
      options: object,
    ) => spawn(process.execPath + ".absent", [], options)) as typeof spawn;
    await expect(
      runWindowsFilesystem({ operation: "write" }, undefined, missing),
    ).rejects.toMatchObject({
      code: "filesystem_windows_helper_unavailable",
      data: { operationOutcome: "not_started", retryable: false },
    });
  });

  test("cancelling a running write kills the helper and reports an unknown outcome", async () => {
    const controller = new AbortController();
    const held: typeof spawn = ((
      _file: string,
      _args: string[],
      options: object,
    ) => {
      const child = spawn(
        process.execPath,
        ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
        options,
      );
      child.once("spawn", () => controller.abort());
      return child;
    }) as typeof spawn;
    await expect(
      runWindowsFilesystem({ operation: "write" }, controller.signal, held),
    ).rejects.toMatchObject({
      code: "filesystem_windows_interrupted",
      data: { operationOutcome: "unknown", retryable: false },
    });
  });
});
