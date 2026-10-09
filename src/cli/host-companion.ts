import { homedir } from "node:os";
import {
  openPluginInstallLink,
  parsePluginInstallArguments,
} from "../computer-access/companion/install-link.js";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import type { NativeAutostartOptions } from "../computer-access/companion/autostart.js";
import {
  normalizeNativeRuntimeUrl,
  resolveNativeRuntimeAddress,
} from "../computer-access/companion/native-address.js";
import { readNativeHostIdentity } from "../computer-access/companion/native-identity.js";
import { connectNativeHost } from "../computer-access/companion/native-session.js";
import {
  createNativeHostState,
  type NativeHostState,
} from "../computer-access/companion/native-state.js";
import { runNativeHostSupervisor } from "../computer-access/companion/native-supervisor.js";
import {
  isProcessOwnerAlive,
  requireCurrentProcessOwnerIdentity,
} from "../computer-access/companion/process-owner-identity.js";
import { acquireFileLock } from "../runtime/adapters/long-term-memory/file-lock/acquisition.js";
import { ensurePrivateRuntimeDirectory } from "../runtime/local-host/private-directory.js";
import { assertPrivateRuntimeAccess } from "../runtime/local-host/private-access.js";
import {
  defaultHostCompanionLifecycle,
  type HostCompanionLifecycle,
} from "./host-companion-lifecycle.js";
import {
  assertFreshHostPairingGrant,
  canResumeHostCompanionPairing,
  resolveHostCompanionSetupUrl,
  requiresFreshHostPairing,
} from "./host-companion-setup-target.js";
import { stopOwnedNativeCompanion } from "../computer-access/companion/native-replacement.js";
import { readNativeCompanionBuildId } from "../computer-access/companion/native-build-identity.js";
import { runHostPermissionsCli } from "./host-permissions.js";

function printHostHelp(): void {
  console.log(
    [
      "Usage:",
      "  abot host connect --url http://localhost:5177",
      "  abot host status",
      "  abot host permissions [--request screen-recording|accessibility]",
      "  abot host disconnect",
      "  abot host uninstall",
      "  abot host run",
      "  abot host open-link <abot://install link>",
      "",
      "Connect asks for a one-time code from ABot Settings, saves a private credential,",
      "and starts the companion now and at future Windows/macOS/Linux desktop logins.",
      "Run is the foreground companion used by the login registration.",
      "Disconnect/uninstall stop the registration and remove this computer's credential.",
      "Revoke the host in ABot Settings to remove Runtime-side pairing too.",
    ].join("\n"),
  );
}

export function createHostCompanionState(): NativeHostState {
  return createNativeHostState(join(homedir(), ".abot", "host-companion"), {
    ensureDirectory: ensurePrivateRuntimeDirectory,
    assertFile: (path, stat) =>
      assertPrivateRuntimeAccess(
        path,
        stat,
        "host_companion_state_not_private",
      ),
  });
}

export type HostCompanionCliOptions = Readonly<{
  cliPath?: string;
  pairingCode?: string;
  upgradeHostId?: string;
  /** Store fresh connection consent must consume its new grant even with stale state. */
  pairingMode?: "fresh-grant";
  lifecycle?: HostCompanionLifecycle;
}>;

function autostartOptions(
  state: NativeHostState,
  options: HostCompanionCliOptions = {},
): NativeAutostartOptions {
  return {
    platform: process.platform,
    homeDir: homedir(),
    appData: process.env.APPDATA,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    uid: process.getuid?.(),
    nodePath: process.execPath,
    cliPath:
      options.cliPath ?? fileURLToPath(new URL("./bin.js", import.meta.url)),
    stateDir: state.directory,
  };
}

async function readPairingCode(): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (await prompt.question("One-time pairing code: ")).trim();
  } finally {
    prompt.close();
  }
}

async function withStopSignals(
  operation: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await operation(controller.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function connectHost(
  args: string[],
  state: NativeHostState,
  options: HostCompanionCliOptions,
): Promise<void> {
  if (args.length !== 2 || args[0] !== "--url")
    throw new Error("Usage: abot host connect --url http://localhost:5177");
  const startup = autostartOptions(state, options);
  const lifecycle = options.lifecycle ?? defaultHostCompanionLifecycle;
  await lifecycle.assertStartupSupported(startup);
  assertFreshHostPairingGrant(
    options.pairingMode, options.pairingCode, options.upgradeHostId,
  );
  const saved = await state.read();
  const url = resolveHostCompanionSetupUrl(
    saved,
    normalizeNativeRuntimeUrl(args[1]!),
    options.upgradeHostId,
  );
  await resolveNativeRuntimeAddress(url);
  if (canResumeHostCompanionPairing(saved, options.pairingMode)) {
    await lifecycle.completeStartup(state, startup, saved.hostId);
    return;
  }
  // The old process must exit before its credential is replaced; its in-flight
  // authorization failure must not race with the new saved connection.
  if (requiresFreshHostPairing(options.pairingMode))
    await stopOwnedNativeCompanion(state.directory);
  const code = options.pairingCode ?? (await readPairingCode());
  let pairedHostId: string | undefined;
  let interrupted = false;
  await withStopSignals(async (signal) => {
    const connection = new AbortController();
    const stop = () => connection.abort();
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (signal.aborted) stop();
      await connectNativeHost({
        url,
        authorization: code,
        identity: readNativeHostIdentity(),
        signal: connection.signal,
        onPaired: async (hostId, credential) => {
          await state.write({ version: 1, url, hostId, credential });
          pairedHostId = hostId;
        },
        onReady: () => {
          throw new Error(
            "Pairing must finish before an authenticated native connection becomes ready.",
          );
        },
      });
    } finally {
      interrupted = signal.aborted;
      signal.removeEventListener("abort", stop);
    }
  });
  if (interrupted)
    throw new Error("Host setup was interrupted before startup installation.");
  if (!pairedHostId)
    throw new Error(
      "Pairing did not complete. Check ABot Settings and use a fresh pairing code.",
    );
  await lifecycle.completeStartup(state, startup, pairedHostId);
}

async function runHost(
  state: NativeHostState,
  options: HostCompanionCliOptions,
): Promise<void> {
  const saved = await state.read();
  if (!saved) return;
  const buildId = await readNativeCompanionBuildId(
    autostartOptions(state, options).cliPath,
  );
  const ownerIdentity = await requireCurrentProcessOwnerIdentity();
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireFileLock(join(state.directory, "agent"), {
      waitMs: 0,
      releaseMode: "synchronous",
      ownerIdentity,
      processIsAlive: isProcessOwnerAlive,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "long_term_memory_store_lock_timeout"
    )
      return;
    throw error;
  }
  try {
    await withStopSignals(async (signal) =>
      runNativeHostSupervisor({
        state,
        identity: readNativeHostIdentity(),
        signal,
        buildId,
        ...(options.lifecycle?.createNotifications
          ? {
              notifications: await options.lifecycle.createNotifications(
                saved.url,
                signal,
              ),
            }
          : {}),
      }),
    );
  } finally {
    await release();
  }
}

export async function runHostCompanionCli(
  args: string[],
  options: HostCompanionCliOptions = {},
): Promise<void> {
  const [command, ...rest] = args;
  if (!command || ["help", "--help", "-h"].includes(command)) {
    printHostHelp();
    return;
  }
  if (command === "permissions") {
    await runHostPermissionsCli(rest);
    return;
  }
  const state = createHostCompanionState();
  if (command === "connect") {
    await connectHost(rest, state, options);
    return;
  }
  if (command === "open-link") {
    await openPluginInstallLink(state, parsePluginInstallArguments(rest));
    return;
  }
  if (rest.length > 0) throw new Error(`Unknown host argument: ${rest[0]}`);
  if (command === "run") {
    await runHost(state, options);
    return;
  }
  if (command === "disconnect" || command === "uninstall") {
    await (options.lifecycle ?? defaultHostCompanionLifecycle).uninstall(
      state,
      autostartOptions(state, options),
    );
    return;
  }
  if (command === "status") {
    const saved = await state.read();
    console.log(
      JSON.stringify(
        saved
          ? {
              paired: true,
              url: saved.url,
              hostId: saved.hostId,
              connected: await state.isConnected(saved.hostId),
            }
          : { paired: false, connected: false },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(`Unknown host command: ${command}`);
}
