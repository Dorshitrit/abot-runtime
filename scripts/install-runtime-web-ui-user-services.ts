import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const WEB_UI_SERVER_UNIT = "abot-llm-runtime-web-ui-v1.service";
export const WEB_UI_OPEN_UNIT = "abot-llm-runtime-web-ui-open-v1.service";

type UnitPaths = Readonly<{
  rootDir: string;
  node: string;
  tsxCli: string;
  controlScript: string;
  webUiServer: string;
}>;

function quoteSystemdArgument(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderRuntimeWebUiUnit(
  template: string,
  paths: UnitPaths,
): string {
  const replacements: Readonly<Record<string, string>> = {
    "@@ROOT_DIR@@": paths.rootDir,
    "@@NODE@@": quoteSystemdArgument(paths.node),
    "@@TSX_CLI@@": quoteSystemdArgument(paths.tsxCli),
    "@@CONTROL_SCRIPT@@": quoteSystemdArgument(paths.controlScript),
    "@@WEB_UI_SERVER@@": quoteSystemdArgument(paths.webUiServer),
  };
  return Object.entries(replacements).reduce(
    (rendered, [placeholder, value]) => rendered.replaceAll(placeholder, value),
    template,
  );
}

async function defaultSystemctl(args: readonly string[]): Promise<void> {
  await execFileAsync("systemctl", ["--user", ...args]);
}

export async function installRuntimeWebUiUserServices(
  options: {
    rootDir?: string;
    unitDir?: string;
    nodePath?: string;
    runSystemctl?: (args: readonly string[]) => Promise<void>;
  } = {},
): Promise<Readonly<{ unitDir: string; units: readonly string[] }>> {
  const rootDir = resolve(options.rootDir ?? ROOT_DIR);
  const unitDir = resolve(
    options.unitDir ?? join(homedir(), ".config", "systemd", "user"),
  );
  const templateDir = join(rootDir, "systemd", "user");
  const paths: UnitPaths = {
    rootDir,
    node: options.nodePath ?? process.execPath,
    tsxCli: join(rootDir, "node_modules", "tsx", "dist", "cli.mjs"),
    controlScript: join(rootDir, "scripts", "runtime-service-web-ui.ts"),
    webUiServer: join(rootDir, "src", "web-ui", "server.ts"),
  };
  const units = [WEB_UI_SERVER_UNIT, WEB_UI_OPEN_UNIT] as const;

  await mkdir(unitDir, { recursive: true });
  for (const unit of units) {
    const template = await readFile(join(templateDir, `${unit}.in`), "utf-8");
    const rendered = renderRuntimeWebUiUnit(template, paths);
    await writeFile(join(unitDir, unit), rendered, "utf-8");
  }

  const runSystemctl = options.runSystemctl ?? defaultSystemctl;
  await runSystemctl(["daemon-reload"]);
  // Enable only: installation never starts or restarts runtime or browser units.
  await runSystemctl(["enable", WEB_UI_OPEN_UNIT]);

  return { unitDir, units };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  void installRuntimeWebUiUserServices().then(
    ({ unitDir, units }) => {
      console.log(`Installed ${units.join(", ")} in ${unitDir}.`);
      console.log(
        "They will take effect on the next llm-runtime.service activation.",
      );
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
