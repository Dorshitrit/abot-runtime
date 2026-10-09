import { stdin } from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeNativeRuntimeUrl, resolveNativeRuntimeAddress } from "../computer-access/companion/native-address.js";
import { parseStoreConnectionLink, STORE_CONNECTION_LINK_MAX_BYTES } from "../computer-access/companion/windows-store/connection-link.js";
import { WINDOWS_COMPANION_AUMID } from "../computer-access/companion/windows-store/identity.js";
import { createWindowsStoreLifecycle } from "../computer-access/companion/windows-store/lifecycle.js";
import { hasMissingStoreUpgradeConnection, MissingStoreConnectionError, serializeStoreConnectionError } from "../computer-access/companion/windows-store/connection-error.js";
import { createHostCompanionState, runHostCompanionCli } from "./host-companion.js";
import { readHostCompanionInput } from "./host-companion-input.js";
import { resolveHostCompanionSetupUrl } from "./host-companion-setup-target.js";

function browserOrigin(runtimeUrl: string): string {
  const url = new URL(runtimeUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

/** Store-specific activation; all pairing, state and tool execution remain in the shared CLI. */
export async function runWindowsCompanionStoreEntry(
  args: string[],
  options: Readonly<{
    input?: Readable;
    cliPath?: string;
    runCli?: typeof runHostCompanionCli;
    createState?: typeof createHostCompanionState;
  }> = {},
): Promise<void> {
  const [command, ...rest] = args;
  const cliPath = options.cliPath ?? fileURLToPath(import.meta.url);
  const runCli = options.runCli ?? runHostCompanionCli;
  const lifecycle = createWindowsStoreLifecycle({ appUserModelId: WINDOWS_COMPANION_AUMID });
  if (command === "host") {
    if (!['run', 'status', 'disconnect', 'uninstall', '--help'].includes(rest[0] ?? '') || rest.length !== 1)
      throw new Error("Unsupported Companion command.");
    await runCli(rest, { cliPath, lifecycle });
    return;
  }
  if (rest.length !== 0) throw new Error("Companion links must be sent on standard input.");
  if (!["inspect-link", "setup-link", "open-plugin-link"].includes(command ?? ""))
    throw new Error("Unsupported Companion command.");
  const link = await readHostCompanionInput(options.input ?? stdin, STORE_CONNECTION_LINK_MAX_BYTES);
  if (command === "open-plugin-link") {
    await runCli(["open-link", link], { cliPath, lifecycle });
    return;
  }
  const invitation = parseStoreConnectionLink(link);
  const state = (options.createState ?? createHostCompanionState)();
  const saved = await state.read();
  if (hasMissingStoreUpgradeConnection(invitation.upgradeHostId, saved))
    throw new MissingStoreConnectionError();
  const target = resolveHostCompanionSetupUrl(saved, normalizeNativeRuntimeUrl(invitation.url), invitation.upgradeHostId);
  await resolveNativeRuntimeAddress(target);
  if (command === "inspect-link") {
    console.log(JSON.stringify({
      runtimeUrl: browserOrigin(target),
      expiresAt: invitation.expiresAt,
      paired: Boolean(saved),
      ...(saved ? { existingRuntimeUrl: browserOrigin(saved.url) } : {}),
    }));
    return;
  }
  // Revalidated by the CLI immediately before pairing; inspection never grants consent itself.
  await runCli(["connect", "--url", invitation.url], {
    cliPath, lifecycle, pairingCode: invitation.code,
    ...(invitation.upgradeHostId
      ? { upgradeHostId: invitation.upgradeHostId }
      : { pairingMode: "fresh-grant" as const }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runWindowsCompanionStoreEntry(process.argv.slice(2)).catch((error: unknown) => {
    // Neither activation URI nor one-time authorization may appear in process output.
    console.error(serializeStoreConnectionError(error));
    process.exitCode = 1;
  });
}
