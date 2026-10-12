import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import createFilesystemPlugin from "../../../plugins/filesystem/source/index.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

const execute = promisify(execFile);
afterEach(removePortablePluginFixtures);
const ACL_PROBE = String.raw`
$ErrorActionPreference='Stop'
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
$path=$env:ABOT_FILESYSTEM_ACL_TEST_PATH
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:ABOT_FILESYSTEM_ACL_TEST_PRIVATE -eq '1') {
  $acl=New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true,$false)
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($current,'FullControl','Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
}
$observed=Get-Acl -LiteralPath $path
$rules=@($observed.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
$onlyCurrent=$rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $current.Value
$descriptor=$observed.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
$hash=[Security.Cryptography.SHA256]::Create()
$hashText=[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($descriptor)))
@{protected=$observed.AreAccessRulesProtected;onlyCurrent=$onlyCurrent;hash=$hashText} | ConvertTo-Json -Compress
`;

async function permissions(path: string, makePrivate = false) {
  const result = await execute(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ACL_PROBE],
    {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16_384,
      env: {
        ...process.env,
        ABOT_FILESYSTEM_ACL_TEST_PATH: path,
        ABOT_FILESYSTEM_ACL_TEST_PRIVATE: makePrivate ? "1" : "0",
      },
    },
  );
  return JSON.parse(result.stdout) as {
    protected: boolean;
    onlyCurrent: boolean;
    hash: string;
  };
}

describe.skipIf(process.platform !== "win32")(
  "filesystem Windows permission preservation",
  () => {
    test("new files are private and replacing an existing file preserves its DACL", async () => {
      const context = await createPortablePluginFixture("filesystem");
      const root = context.runtimePaths.agentWorkDir;
      await mkdir(root, { recursive: true });
      const plugin = createFilesystemPlugin(context);
      const existing = join(root, "existing.txt");
      await writeFile(existing, "original");
      const before = await permissions(existing, true);
      expect(before).toMatchObject({ protected: true, onlyCurrent: true });
      expect(
        await plugin.handlers.write_file!({
          path: "existing.txt",
          content: "replacement",
        }),
      ).toMatchObject({ ok: true });
      expect(await permissions(existing)).toEqual(before);
      expect(
        await plugin.handlers.write_file!({
          path: "new.txt",
          content: "private content",
        }),
      ).toMatchObject({ ok: true });
      expect(await permissions(join(root, "new.txt"))).toMatchObject({
        protected: true,
        onlyCurrent: true,
      });
    }, 20_000);

    test("a read-only target is preserved and the uncommitted private temporary file is removed", async () => {
      const context = await createPortablePluginFixture("filesystem");
      const root = context.runtimePaths.agentWorkDir;
      await mkdir(root, { recursive: true });
      const file = join(root, "readonly.txt");
      await writeFile(file, "user content");
      const setAttributes = async (value: string) =>
        execute(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[IO.File]::SetAttributes($env:ABOT_FILESYSTEM_ACL_TEST_PATH,[IO.FileAttributes]$env:ABOT_FILESYSTEM_TEST_ATTRIBUTES)",
          ],
          {
            windowsHide: true,
            env: {
              ...process.env,
              ABOT_FILESYSTEM_ACL_TEST_PATH: file,
              ABOT_FILESYSTEM_TEST_ATTRIBUTES: value,
            },
            timeout: 10_000,
          },
        );
      await setAttributes("ReadOnly");
      try {
        const result = await createFilesystemPlugin(context).handlers
          .write_file!({ path: "readonly.txt", content: "overwrite" });
        expect(result).toMatchObject({
          ok: false,
          errorCode: "filesystem_access_denied",
        });
        expect(await readFile(file, "utf8")).toBe("user content");
        expect(await readdir(root)).toEqual(["readonly.txt"]);
      } finally {
        await setAttributes("Normal");
      }
    }, 15_000);
  },
);
