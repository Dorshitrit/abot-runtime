import { stdin } from "node:process";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isNativeCredential } from "../computer-access/companion/native-state.js";
import {
  isHostIdentifier,
  isHostRecord,
} from "../computer-access/companion/protocol.js";
import { runHostCompanionCli } from "./host-companion.js";

const SETUP_INPUT_LIMIT_BYTES = 16_384;
const SETUP_INPUT_TIMEOUT_MS = 10_000;

async function readSetupInput(input: Readable): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  const deadline = setTimeout(() => {
    input.destroy(new Error("Host setup input timed out."));
  }, SETUP_INPUT_TIMEOUT_MS);
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > SETUP_INPUT_LIMIT_BYTES)
        throw new Error("Host setup input exceeds the size limit.");
      chunks.push(bytes);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new Error("Host setup requires a JSON object on standard input.");
    }
  } finally {
    clearTimeout(deadline);
  }
}

function readSetupRequest(
  value: unknown,
): Readonly<{ url: string; code: string; upgradeHostId?: string }> {
  if (!isHostRecord(value)) throw new Error("Invalid host setup request.");
  if (
    Object.keys(value).some(
      (key) => !["url", "code", "upgradeHostId"].includes(key),
    )
  )
    throw new Error("Unexpected host setup fields.");
  if (typeof value.url !== "string") throw new Error("Missing Runtime URL.");
  if (value.url.length === 0 || value.url.length > 4_096)
    throw new Error("Invalid Runtime URL length.");
  if (!isNativeCredential(value.code)) throw new Error("Invalid pairing code.");
  if (
    value.upgradeHostId !== undefined &&
    !isHostIdentifier(value.upgradeHostId)
  )
    throw new Error("Invalid paired computer identity.");
  return {
    url: value.url,
    code: value.code,
    ...(value.upgradeHostId !== undefined
      ? { upgradeHostId: value.upgradeHostId }
      : {}),
  };
}

/** Installer-only setup receives secrets over stdin; login startup uses host run. */
export async function runHostCompanionEntry(
  args: string[],
  options: Readonly<{
    input?: Readable;
    cliPath?: string;
    runCli?: typeof runHostCompanionCli;
  }> = {},
): Promise<void> {
  const cliPath = options.cliPath ?? fileURLToPath(import.meta.url);
  const runCli = options.runCli ?? runHostCompanionCli;
  if (args[0] === "setup") {
    if (args.length !== 1)
      throw new Error(
        "Host setup accepts JSON on standard input, not arguments.",
      );
    const setup = readSetupRequest(
      await readSetupInput(options.input ?? stdin),
    );
    await runCli(["connect", "--url", setup.url], {
      cliPath,
      pairingCode: setup.code,
      ...(setup.upgradeHostId ? { upgradeHostId: setup.upgradeHostId } : {}),
    });
    return;
  }
  if (args[0] !== "host")
    throw new Error("Use setup or host <run|status|disconnect|uninstall>.");
  await runCli(args.slice(1), { cliPath });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runHostCompanionEntry(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Host companion failed.",
    );
    process.exitCode = 1;
  });
}
