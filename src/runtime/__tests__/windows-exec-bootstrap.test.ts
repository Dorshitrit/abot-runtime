import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WINDOWS_EXEC_BOOTSTRAP } from "../../../plugins/exec/source/windows-shell-bootstrap.js";
import { WINDOWS_EXEC_JOB_SOURCE } from "../../../plugins/exec/source/windows-job-source.js";
import { execShell } from "../../../plugins/exec/source/shell-platform.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

afterEach(removePortablePluginFixtures);
describe.skipIf(process.platform !== "win32")(
  "Windows EXEC setup rejection",
  () => {
    test.each(["language-policy", "helper-unavailable"])(
      "rejects %s before running the command",
      async (reason) => {
        const context = await createPortablePluginFixture("exec");
        const marker = join(context.rootDir, "must-not-exist.txt");
        const bootstrap =
          reason === "language-policy"
            ? "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';" +
              WINDOWS_EXEC_BOOTSTRAP
            : WINDOWS_EXEC_BOOTSTRAP;
        const child = spawn(
          execShell(),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(bootstrap, "utf16le").toString("base64"),
          ],
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        const outcome = new Promise<{ code: number | null; error: string }>(
          (resolve, reject) => {
            let error = "";
            child.stdout.resume();
            child.stderr.on("data", (chunk) => {
              error += String(chunk);
            });
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, error }));
          },
        );
        child.stdin.on("error", () => {});
        child.stdin.end(
          JSON.stringify({
            source:
              reason === "helper-unavailable"
                ? "invalid C#"
                : WINDOWS_EXEC_JOB_SOURCE,
            command:
              "[IO.File]::WriteAllText('" +
              marker.replaceAll("'", "''") +
              "','unexpected')",
          }),
          "utf8",
        );
        try {
          const result = await outcome;
          expect(result.code).toBe(126);
          expect(result.error.length).toBeGreaterThan(0);
          await expect(access(marker)).rejects.toMatchObject({
            code: "ENOENT",
          });
        } finally {
          if (child.exitCode === null) child.kill("SIGKILL");
        }
      },
      30_000,
    );
  },
);
