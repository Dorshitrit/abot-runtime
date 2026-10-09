import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NativeAutostartOptions } from "./autostart.js";

export function renderMacInstallLinkHandler(
  options: NativeAutostartOptions,
): string {
  const literal = (value: string) => JSON.stringify(value);
  return `ObjC.import('Foundation');
function openDocuments() {}
function openLocation(url) {
  var task = $.NSTask.alloc.init;
  task.launchPath = ${literal(options.nodePath)};
  task.arguments = [${literal(options.cliPath)}, 'host', 'open-link', String(url)];
  task.launch;
}
`;
}

export const MAC_INSTALL_LINK_BUNDLE_ID = "com.abot.install-links";

export const MAC_INSTALL_LINK_HANDLER_QUERY_SCRIPT = `ObjC.import('CoreServices');
function run(argv) {
  var handler = ObjC.castRefToObject($.LSCopyDefaultHandlerForURLScheme($(argv[0])));
  if (handler.isNil()) return '';
  return ObjC.unwrap(handler);
}
`;

const executeFile = promisify(execFile);

function isAvailableMacInstallScheme(handler: string): boolean {
  if (!handler) return true;
  return handler === MAC_INSTALL_LINK_BUNDLE_ID;
}

export async function requireAvailableMacInstallScheme(): Promise<void> {
  const { stdout } = await executeFile(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", MAC_INSTALL_LINK_HANDLER_QUERY_SCRIPT, "abot"],
    { timeout: 30_000, maxBuffer: 16_384 },
  );
  if (!isAvailableMacInstallScheme(stdout.trim()))
    throw new Error("The abot URL scheme belongs to another application.");
}

/** Preserve the executable and scripting metadata emitted by osacompile. */
export const MAC_INSTALL_LINK_PLIST_SCRIPT = `ObjC.import('Foundation');
function run(argv) {
  var plist = $.NSMutableDictionary.alloc.initWithContentsOfFile($(argv[0]));
  if (!plist) throw new Error('Installation-link bundle has no property list.');
  var updates = {
    CFBundleIdentifier: '${MAC_INSTALL_LINK_BUNDLE_ID}',
    CFBundleName: 'ABot Install',
    LSUIElement: true,
    CFBundleURLTypes: [{CFBundleURLName: 'ABot installation links', CFBundleURLSchemes: ['abot']}]
  };
  Object.keys(updates).forEach(function(key) { plist.setObjectForKey($(updates[key]), $(key)); });
  if (!plist.writeToFileAtomically($(argv[0]), true)) throw new Error('Could not register installation links.');
}
`;
