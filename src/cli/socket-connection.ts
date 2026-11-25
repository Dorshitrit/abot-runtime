import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readPrivateConnectionJson, resolveConfiguredRuntimeConnection } from "../bridge/configured-runtime-connection.js";
import { loadRuntimeConfig } from "../runtime/config.js";
import type { SocketConnectionManagement, SocketConnectionPreview, SocketConnectionStatus } from "../runtime/socket-connection/contracts.js";
import { withSocketConnectionManagement } from "../runtime/socket-connection/offline.js";
import { loadDotEnvFile } from "../shared/load-dotenv.js";

const usage = [
  "abot socket connect --file <bundle.json> [--environment <id>] [--yes]",
  "abot socket status|pause|resume [--environment <id>]",
  "abot socket forget [--environment <id>] [--yes]",
].join("\n");

type Command = "connect" | "status" | "pause" | "resume" | "forget";
type Arguments = { command: Command; file?: string; environment?: string; yes: boolean };

function parseArguments(args: string[]): Arguments {
  const [command, ...rest] = args;
  if (command !== "connect" && command !== "status" && command !== "pause" && command !== "resume" && command !== "forget") {
    throw new Error(usage);
  }
  const options: Arguments = { command, yes: false };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--yes" && !options.yes && (command === "connect" || command === "forget")) {
      options.yes = true;
      continue;
    }
    const isFileOption = flag === "--file" && command === "connect" && !options.file;
    const isEnvironmentOption = flag === "--environment" && !options.environment;
    if (!isFileOption && !isEnvironmentOption) throw new Error(usage);
    const value = rest[++i];
    if (!value?.trim() || value.startsWith("--")) throw new Error(usage);
    if (isFileOption) options.file = value;
    else options.environment = value;
  }
  if (command === "connect" && !options.file) throw new Error(usage);
  return options;
}

function printTarget(target: Pick<SocketConnectionPreview, "localEnvironmentId"> & { remoteRuntimeId: string | null; serverOrigin: string | null }) {
  console.log("Local environment   " + JSON.stringify(target.localEnvironmentId));
  if (target.remoteRuntimeId) console.log("Remote runtime      " + JSON.stringify(target.remoteRuntimeId));
  if (target.serverOrigin) console.log("Socket server       " + target.serverOrigin);
}

function printStatus(status: SocketConnectionStatus) {
  printTarget(status);
  console.log("Connection          " + status.state.replaceAll("_", " "));
  if (status.source) console.log("Source              " + status.source);
  if (status.error) console.log("Issue               " + status.error);
  if (status.nextRetryAt) console.log("Next retry          " + status.nextRetryAt);
}

async function confirm(question: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Confirmation required. Run in a terminal or pass --yes.");
  const input = createInterface({ input: stdin, output: stdout });
  try { return /^(?:y|yes)$/i.test((await input.question(question + " [y/N] ")).trim()); }
  finally { input.close(); }
}

export async function runSocketConnectionCli(args: string[]): Promise<void> {
  if (!args.length || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    console.log(usage);
    return;
  }
  const options = parseArguments(args);
  const rootDir = process.cwd();
  loadDotEnvFile(join(rootDir, ".env"));
  const defaultConfig = loadRuntimeConfig({ rootDir, profileId: process.env.LLM_RUNTIME_WEB_ENVIRONMENT?.trim() || undefined });
  const config = options.environment && options.environment !== defaultConfig.runtimeId
    ? loadRuntimeConfig({ rootDir, profileId: options.environment }) : defaultConfig;
  let legacy: ReturnType<typeof resolveConfiguredRuntimeConnection>;
  try { legacy = resolveConfiguredRuntimeConnection(config, defaultConfig.runtimeId, rootDir); }
  catch { console.warn("Existing Socket connection configuration needs attention."); }
  const manage = <T>(operation: (client: SocketConnectionManagement) => Promise<T>) =>
    withSocketConnectionManagement(config, operation, legacy);
  if (options.command === "connect") {
    const bundle = readPrivateConnectionJson(resolve(rootDir, options.file!));
    const { target, revision } = await manage(async client => ({
      target: await client.preview(bundle), revision: (await client.status()).revision,
    }));
    printTarget(target);
    if (!await confirm("Connect this environment to this Socket server?", options.yes)) return;
    printStatus(await manage(client => client.import({ bundle, confirmBinding: true, expectedRevision: revision })));
    return;
  }
  const command = options.command;
  if (command === "forget") {
    const current = await manage(client => client.status());
    printTarget(current);
    if (!await confirm("Forget this connection on this machine?", options.yes)) return;
    printStatus(await manage(client => client.forget({ expectedRevision: current.revision })));
    console.log("Connection forgotten locally. Manage credential revocation on your Socket server.");
    return;
  }
  printStatus(await manage(async client => {
    const current = await client.status();
    if (command === "status") return current;
    return client[command]({ expectedRevision: current.revision });
  }));
}
