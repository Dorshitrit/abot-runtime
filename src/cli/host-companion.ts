import { homedir } from "node:os";
import { uninstallDesktopNotificationIdentity } from "../computer-access/companion/notification-installation.js";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import {
  nativeAutostartFile,
  uninstallNativeAutostart,
  type NativeAutostartOptions,
} from "../computer-access/companion/autostart.js";
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
import { completeHostCompanionStartup } from "./host-companion-startup.js";
import { resolveHostCompanionSetupUrl } from "./host-companion-setup-target.js";
import { readNativeCompanionBuildId } from "../computer-access/companion/native-build-identity.js";

function printHostHelp(): void {
  console.log(
    [
      "Usage:",
      "  abot host connect --url http://localhost:5177",
      "  abot host status",
      "  abot host disconnect",
      "  abot host uninstall",
      "  abot host run",
      "",
      "Connect asks for a one-time code from ABot Settings, saves a private credential,",
      "and starts the companion now and at future Windows/macOS/Linux desktop logins.",
      "Run is the foreground companion used by the login registration.",
      "Disconnect/uninstall stop the registration and remove this computer's credential.",
      "Revoke the host in ABot Settings to remove Runtime-side pairing too.",
    ].join("\n"),
  );
}

function nativeState(): NativeHostState {
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
  nativeAutostartFile(startup);
  const saved = await state.read();
  const url = resolveHostCompanionSetupUrl(
    saved,
    normalizeNativeRuntimeUrl(args[1]!),
    options.upgradeHostId,
  );
  await resolveNativeRuntimeAddress(url);
  if (saved) {
    await completeHostCompanionStartup(state, startup, saved.hostId);
    return;
  }
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
  await completeHostCompanionStartup(state, startup, pairedHostId);
}

async function runHost(
  state: NativeHostState,
  options: HostCompanionCliOptions,
): Promise<void> {
  if (!(await state.read())) return;
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
    await withStopSignals((signal) =>
      runNativeHostSupervisor({
        state,
        identity: readNativeHostIdentity(),
        signal,
        buildId,
      }),
    );
  } finally {
    await release();
  }
}

async function disconnectHost(state: NativeHostState): Promise<void> {
  await state.remove();
  await uninstallNativeAutostart(autostartOptions(state));
  await uninstallDesktopNotificationIdentity(autostartOptions(state));
  const ownerIdentity = await requireCurrentProcessOwnerIdentity();
  const release = await acquireFileLock(join(state.directory, "agent"), {
    waitMs: 5_000,
    releaseMode: "synchronous",
    ownerIdentity,
    processIsAlive: isProcessOwnerAlive,
  });
  await release();
  console.log(
    "Host companion stopped. Login startup and the saved credential were removed.",
  );
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
  const state = nativeState();
  if (command === "connect") {
    await connectHost(rest, state, options);
    return;
  }
  if (rest.length > 0) throw new Error(`Unknown host argument: ${rest[0]}`);
  if (command === "run") {
    await runHost(state, options);
    return;
  }
  if (command === "disconnect" || command === "uninstall") {
    await disconnectHost(state);
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
