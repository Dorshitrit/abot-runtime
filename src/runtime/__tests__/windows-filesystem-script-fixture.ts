import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { createPortablePluginFixture } from "./windows-portable-plugins-fixture.js";

/** Real Windows helper with test-only native checkpoints; no timed race polling. */
export async function runFilesystemScript(
  source: string,
  root: string,
  request: Readonly<Record<string, unknown>>,
  interruptAt?: string,
): Promise<unknown> {
  const identity = await stat(root, { bigint: true });
  const bootstrap = [
    "$ErrorActionPreference='Stop'",
    "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')",
    "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    "$inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json",
    "Add-Type -ReferencedAssemblies @('System.Web.Extensions') -TypeDefinition $inputData.source",
    "[Console]::Write([AbotFilesystem]::Run($inputData.request))",
  ].join(";");
  const stdout = await new Promise<string>((resolve, reject) => {
    let interrupted = false;
    let checkpointOutput = "";
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", bootstrap],
      { windowsHide: true, timeout: 15_000, maxBuffer: 16_384 },
      (error, output) => {
        if (interrupted && error?.killed) {
          resolve(JSON.stringify({ interruptedAt: interruptAt }));
          return;
        }
        if (error) reject(error);
        else resolve(output);
      },
    );
    if (interruptAt) {
      child.stdout!.on("data", (chunk: Buffer) => {
        checkpointOutput = (checkpointOutput + chunk.toString()).slice(-16_384);
        if (interrupted || !checkpointOutput.includes(interruptAt)) return;
        interrupted = child.kill("SIGKILL");
      });
    }
    child.stdin!.end(
      JSON.stringify({
        source,
        request: JSON.stringify({
          ...request,
          rootPath: root,
          rootIdentity: {
            device: String(identity.dev),
            inode: String(identity.ino),
            birthtimeNs: String(identity.birthtimeNs),
          },
        }),
      }),
    );
  });
  return JSON.parse(stdout);
}

export async function createFilesystemScriptFixture() {
  const context = await createPortablePluginFixture("filesystem");
  const root = context.runtimePaths.agentWorkDir;
  await mkdir(root, { recursive: true });
  return { context, root };
}
