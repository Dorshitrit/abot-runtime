import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { NotificationProcessInput } from "../../../computer-access/companion/notification-process.js";

export async function createCompiledMacNotificationFixture(app: string, executable: string) {
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(app, "Contents", "MacOS", executable), "compiled fixture", { mode: 0o755 });
  await writeFile(join(app, "Contents", "Info.plist"), JSON.stringify({
    CFBundleExecutable: executable,
    CFBundleIdentifier: "com.apple.ScriptEditor.fixture",
    CFBundlePackageType: "APPL",
    CFBundleSignature: executable === "droplet" ? "dplt" : "aplt",
    CFBundleIconFile: executable,
    CFBundleDocumentTypes: [{ CFBundleTypeRole: "Viewer" }],
    compilerMetadata: { retained: true },
  }));
}

/** Execute production plist mutation against a filesystem-backed Foundation fake. */
export function runMacNotificationPlistFixture(input: NotificationProcessInput): string | undefined {
  if (input.file !== "/usr/bin/osascript") return undefined;
  const source = input.args[3];
  if (!source?.includes("NSMutableDictionary")) return undefined;
  const context: any = {
    $: Object.assign((value: unknown) => value, {
      NSMutableDictionary: { alloc: { initWithContentsOfFile: (path: string) => {
        const data = JSON.parse(readFileSync(path, "utf8"));
        return {
          objectForKey: (key: string) => data[key],
          setObjectForKey: (value: unknown, key: string) => { data[key] = value; },
          writeToFileAtomically: (target: string) => {
            writeFileSync(target, JSON.stringify(data));
            return true;
          },
        };
      } } },
    }),
    ObjC: { import() {}, unwrap: (value: unknown) => value },
  };
  runInNewContext(source, context);
  return context.run(input.args.slice(4));
}
