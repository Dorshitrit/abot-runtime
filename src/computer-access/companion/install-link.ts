import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parsePluginInstallLink } from "../../plugin-contract/install-source.js";
import { notificationRuntimeOrigin } from "./notification-protocol.js";
import type { NativeHostState } from "./native-state.js";

export function pluginInstallReviewUrl(
  link: string,
  runtimeUrl: string,
): string {
  const source = parsePluginInstallLink(link);
  const url = new URL("/plugins", notificationRuntimeOrigin(runtimeUrl));
  url.searchParams.set("tab", "discover");
  url.searchParams.set("pluginSource", source.repository);
  if (source.ref) url.searchParams.set("pluginRef", source.ref);
  if (source.path) url.searchParams.set("pluginPath", source.path);
  return url.toString();
}

/** The saved pairing owns the destination. Incoming links cannot select a host. */
export async function openPluginInstallLink(
  state: Pick<NativeHostState, "read">,
  link: string,
  open = openReviewBrowser,
): Promise<void> {
  parsePluginInstallLink(link);
  const connection = await state.read();
  if (!connection)
    throw new Error(
      "Connect Computer Access before opening an ABot installation link.",
    );
  await open(pluginInstallReviewUrl(link, connection.url));
}

async function openReviewBrowser(url: string): Promise<void> {
  const execute = promisify(execFile);
  const options = { windowsHide: true, timeout: 10_000, maxBuffer: 16_384 };
  if (process.platform === "win32") {
    await execute(
      "rundll32.exe",
      ["url.dll,FileProtocolHandler", url],
      options,
    );
    return;
  }
  if (process.platform === "darwin") {
    await execute("/usr/bin/open", [url], options);
    return;
  }
  if (process.platform === "linux") {
    await execute("xdg-open", [url], options);
    return;
  }
  throw new Error(
    "ABot installation links are not supported on this platform.",
  );
}

/** Windows Script Host expands percent-delimited environment variables in Run().
 * The launcher sends base64 so a website URL can never interpolate local values. */
export function parsePluginInstallArguments(args: readonly string[]): string {
  if (args.length === 1) return args[0];
  if (args.length !== 2 || args[0] !== "--encoded")
    throw new Error("Usage: abot host open-link <abot://install link>");
  const encoded = args[1];
  if (encoded.length > 12_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
    throw new Error("Invalid encoded installation link.");
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  parsePluginInstallLink(decoded);
  return decoded;
}
