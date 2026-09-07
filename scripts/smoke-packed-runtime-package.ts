import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { PUBLIC_PLUGIN_CAPABILITY_IDS } from "./public-snapshot/contracts.js";
import { createPackedWebSearchProbe } from "./packed-web-search-probe.js";
import { createPackedSystemToolsProbe } from "./packed-system-tools-probe.js";
import { runPackedLocalRuntimeProbe } from "./packed-local-runtime-probe.js";
import { DEFAULT_ROOT_RESPONSE_METHODOLOGY_FILES } from "./runtime-setup-files.js";

type PackResult = {
  filename: string;
};

type PackedPackageManifest = {
  name?: unknown;
};

async function resolvePackedPackageLinkPath(
  packageDir: string,
  consumerNodeModules: string,
): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf-8"),
  ) as PackedPackageManifest;
  if (typeof manifest.name !== "string" || manifest.name.trim() === "") {
    throw new Error("packed runtime package is missing its package name");
  }
  return join(consumerNodeModules, ...manifest.name.split("/"));
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("could not reserve a loopback test port");
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
  return address.port;
}

async function waitForHttp(
  url: string,
  child: ChildProcess,
  readOutput: () => string,
): Promise<Response> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `packed abot start exited before ${url} was ready\n${readOutput()}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The process may still be binding its loopback listener.
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${url}\n${readOutput()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  if (
    !(await Promise.race([
      exited.then(() => true),
      delay(5_000).then(() => false),
    ]))
  ) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function prepareConsumerConfig(
  packageDir: string,
  consumerDir: string,
): Promise<void> {
  const localDir = join(consumerDir, "local");
  const modelsDir = join(localDir, "models");
  const methodologiesDir = join(consumerDir, "methodologies");
  await Promise.all([
    mkdir(modelsDir, { recursive: true }),
    mkdir(methodologiesDir, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(
      join(packageDir, "examples", "runtime.config.example.json"),
      join(localDir, "runtime.config.json"),
    ),
    copyFile(
      join(packageDir, "examples", "request-runner.config.example.json"),
      join(localDir, "request-runner.config.json"),
    ),
    copyFile(
      join(packageDir, "examples", "models", "default.config.json"),
      join(modelsDir, "default.config.json"),
    ),
    ...DEFAULT_ROOT_RESPONSE_METHODOLOGY_FILES.map((relativePath) =>
      copyFile(join(packageDir, relativePath), join(consumerDir, relativePath)),
    ),
  ]);
}

async function writeConsumerProbePlugin(
  consumerDir: string,
  pluginId: string,
  capabilityId: string,
): Promise<void> {
  const pluginDir = join(consumerDir, "plugins", pluginId);
  await mkdir(join(pluginDir, "src"), { recursive: true });
  await writeFile(
    join(pluginDir, "plugin.json"),
    `${JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: pluginId,
        version: "1.0.0",
        description: "Packed consumer plugin discovery probe.",
        extensions: {
          "ai.abot.runtime": {
            version: 1,
            entrypoint: "./src/index.cjs",
            catalogGroups: ["other"],
            capabilities: {
              [capabilityId]: {
                description: "Return a deterministic consumer probe result.",
                routingCapability: "semantic_lookup",
                skills: [],
                operations: {
                  probe: {
                    summary: "Run the consumer plugin probe.",
                    input: {
                      type: "object",
                      additionalProperties: false,
                      properties: {},
                      required: [],
                    },
                    effect: "read_only",
                    approval: "request_policy",
                  },
                },
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  await writeFile(
    join(pluginDir, "src", "index.cjs"),
    `module.exports = { handlers: { ${JSON.stringify(
      capabilityId,
    )}: async () => ({ ok: true, output: "consumer probe", producedNewInformation: true }) } };\n`,
    "utf-8",
  );
}

const tempDir = await mkdtemp(join(tmpdir(), "abot-pack-smoke-"));

try {
  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", tempDir],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const packResults = JSON.parse(packOutput) as PackResult[];
  const filename = packResults[0]?.filename;
  if (!filename) {
    throw new Error("npm pack returned no filename");
  }

  const tarballPath = join(tempDir, basename(filename));
  execFileSync("tar", ["-xzf", tarballPath, "-C", tempDir], {
    stdio: "pipe",
  });

  const packageDir = join(tempDir, "package");
  await symlink(
    resolve("node_modules"),
    join(packageDir, "node_modules"),
    "dir",
  );

  const cliPath = join(packageDir, "dist", "src", "cli", "bin.js");
  const cliSource = await readFile(cliPath, "utf-8");
  if (!cliSource.startsWith("#!/usr/bin/env node")) {
    throw new Error("packed abot CLI is missing its Node.js shebang");
  }

  const linkedCliDir = join(tempDir, "npm-bin-probe");
  const linkedCliPath = join(linkedCliDir, "abot");
  await mkdir(linkedCliDir, { recursive: true });
  await symlink(cliPath, linkedCliPath, "file");
  const linkedHelp = execFileSync(process.execPath, [linkedCliPath, "--help"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!linkedHelp.includes("ABot Runtime")) {
    throw new Error("packed abot CLI did not run through an npm-style symlink");
  }
  const linkedInitHelp = execFileSync(
    process.execPath,
    [linkedCliPath, "init", "--help"],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const linkedAddModelHelp = execFileSync(
    process.execPath,
    [linkedCliPath, "add-model", "--help"],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    !linkedInitHelp.includes("Usage: npx abot init") ||
    linkedInitHelp.includes("npm run init") ||
    !linkedAddModelHelp.includes("Usage: npx abot add-model") ||
    linkedAddModelHelp.includes("npm run add-model")
  ) {
    throw new Error("packed abot CLI exposed source-checkout setup commands");
  }

  const cliConsumerDir = join(tempDir, "cli-consumer");
  await mkdir(cliConsumerDir, { recursive: true });
  const initOutput = execFileSync(
    process.execPath,
    [
      cliPath,
      "init",
      "--provider",
      "ollama",
      "--model",
      "consumer-local-model",
    ],
    { cwd: cliConsumerDir, encoding: "utf-8", stdio: "pipe" },
  );
  const addModelOutput = execFileSync(
    process.execPath,
    [
      cliPath,
      "add-model",
      "--profile",
      "hosted",
      "--provider",
      "openai",
      "--model",
      "consumer-hosted-model",
      "--default",
    ],
    { cwd: cliConsumerDir, encoding: "utf-8", stdio: "pipe" },
  );
  const memoryStatusOutput = execFileSync(
    process.execPath,
    [cliPath, "memory", "status"],
    { cwd: cliConsumerDir, encoding: "utf-8", stdio: "pipe" },
  );
  if (
    !initOutput.includes("Start ABot with npx abot start") ||
    /npm run (?:model-gateway|dev|web-ui)/u.test(initOutput) ||
    !addModelOutput.includes("restart ABot with npx abot start") ||
    addModelOutput.includes("restart the model gateway")
  ) {
    throw new Error(
      "packed abot CLI did not present npm-consumer startup instructions",
    );
  }

  const cliRuntimeConfig = JSON.parse(
    await readFile(
      join(cliConsumerDir, "local", "runtime.config.json"),
      "utf-8",
    ),
  ) as {
    models?: {
      providers?: Record<string, unknown>;
      profiles?: Record<string, unknown>;
    };
  };
  const cliRunnerConfig = JSON.parse(
    await readFile(
      join(cliConsumerDir, "local", "request-runner.config.json"),
      "utf-8",
    ),
  ) as {
    schemaVersion?: unknown;
    models?: {
      defaults?: { profileId?: string; steps?: Record<string, unknown> };
    };
    stepDefaults?: { timeoutMs?: unknown };
    steps?: Record<string, unknown>;
  };
  const hostedModelConfig = JSON.parse(
    await readFile(
      join(cliConsumerDir, "local", "models", "hosted.config.json"),
      "utf-8",
    ),
  ) as { execution?: { policy?: string } };
  if (
    !cliRuntimeConfig.models?.providers?.ollama ||
    !cliRuntimeConfig.models.providers.openai ||
    !cliRuntimeConfig.models.profiles?.default ||
    !cliRuntimeConfig.models.profiles.hosted
  ) {
    throw new Error("packed abot CLI did not preserve and extend model setup");
  }
  const packedRunnerConfigViolatesV2 =
    cliRunnerConfig.schemaVersion !== 2 ||
    cliRunnerConfig.models?.defaults?.profileId !== "hosted" ||
    cliRunnerConfig.stepDefaults?.timeoutMs !== 90_000 ||
    JSON.stringify(cliRunnerConfig.models.defaults.steps) !==
      JSON.stringify({
        "supervisor.response": "default",
        "worker.result": "default",
        "execution.response": "default",
        "tool_payload.raw": "toolPayload.raw",
      }) ||
    Object.keys(cliRunnerConfig.steps ?? {}).join(",") !==
      "supervisor.response,execution.response";
  if (packedRunnerConfigViolatesV2) {
    throw new Error(
      "packed abot CLI did not preserve the sparse Config v2 contract while selecting the requested default",
    );
  }
  if (hostedModelConfig.execution?.policy !== "execution-agent-v1") {
    throw new Error(
      "packed abot CLI did not configure the OpenAI execution policy",
    );
  }
  const memoryStatus = JSON.parse(memoryStatusOutput) as {
    enabled?: unknown;
    providers?: unknown;
  };
  if (
    memoryStatus.enabled !== false ||
    !Array.isArray(memoryStatus.providers)
  ) {
    throw new Error("packed abot memory status did not read consumer config");
  }

  const emptyConsumerDir = join(tempDir, "empty-cli-consumer");
  await mkdir(emptyConsumerDir, { recursive: true });
  const [webPort, gatewayPort] = await Promise.all([
    reserveLoopbackPort(),
    reserveLoopbackPort(),
  ]);
  let startStdout = "";
  let startStderr = "";
  const startProcess = spawn(process.execPath, [cliPath, "start"], {
    cwd: emptyConsumerDir,
    env: {
      ...process.env,
      LLM_RUNTIME_WEB_HOST: "127.0.0.1",
      LLM_RUNTIME_WEB_PORT: String(webPort),
      PORT: String(gatewayPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  startProcess.stdout?.on("data", (chunk: Buffer) => {
    startStdout += chunk.toString("utf-8");
  });
  startProcess.stderr?.on("data", (chunk: Buffer) => {
    startStderr += chunk.toString("utf-8");
  });
  try {
    const healthResponse = await waitForHttp(
      `http://127.0.0.1:${webPort}/web-health`,
      startProcess,
      () => `${startStdout}\n${startStderr}`,
    );
    const health = (await healthResponse.json()) as { ok?: boolean };
    if (health.ok !== true) {
      throw new Error("packed abot start returned an unhealthy Web UI");
    }
    const webConfig = (await fetch(
      `http://127.0.0.1:${webPort}/web-config`,
    ).then((response) => response.json())) as { setupCommandMode?: string };
    if (webConfig.setupCommandMode !== "package") {
      throw new Error(
        "packed abot start did not select npm-consumer setup commands",
      );
    }
    const page = await fetch(`http://127.0.0.1:${webPort}/`).then((response) =>
      response.text(),
    );
    if (!page.includes("ABot Runtime")) {
      throw new Error("packed abot start did not serve the packaged Web UI");
    }
  } finally {
    await stopChild(startProcess);
  }

  const handlerModule = await import(
    pathToFileURL(join(packageDir, "dist/src/runtime/request/handler.js")).href
  );
  if (typeof handlerModule.handleRunRequest !== "function") {
    throw new Error("packed runtime request handler was not loadable");
  }

  const consumerDir = join(tempDir, "consumer");
  const duplicateConsumerDir = join(tempDir, "duplicate-consumer");
  const consumerNodeModules = join(consumerDir, "node_modules");
  const consumerPackageLink = await resolvePackedPackageLinkPath(
    packageDir,
    consumerNodeModules,
  );
  await mkdir(dirname(consumerPackageLink), { recursive: true });
  await symlink(packageDir, consumerPackageLink, "dir");
  await Promise.all([
    prepareConsumerConfig(packageDir, consumerDir),
    prepareConsumerConfig(packageDir, duplicateConsumerDir),
  ]);
  await Promise.all([
    writeConsumerProbePlugin(consumerDir, "consumer-probe", "consumer_probe"),
    writeConsumerProbePlugin(
      duplicateConsumerDir,
      "web",
      "consumer_duplicate_web",
    ),
  ]);

  const smokeFile = join(consumerDir, "smoke.mjs");
  await writeFile(
    smokeFile,
    `
const runtime = await import("@abot-ai/runtime");
const config = await import("@abot-ai/runtime/runtime/config");
const composition = await import("@abot-ai/runtime/runtime/composition");
const defaultAdapters = await import("@abot-ai/runtime/runtime/default-adapters");
const adapters = await import("@abot-ai/runtime/runtime/adapters");
const ports = await import("@abot-ai/runtime/runtime/ports");
const modelGateway = await import("@abot-ai/runtime/model-gateway");
const pluginSdk = await import("@abot-ai/runtime/plugin-sdk");

const expectedPublicCapabilities = ${JSON.stringify(
      [...PUBLIC_PLUGIN_CAPABILITY_IDS].sort(),
    )};
const consumerRoot = ${JSON.stringify(consumerDir)};
const initializedConsumerRoot = ${JSON.stringify(cliConsumerDir)};
const duplicateConsumerRoot = ${JSON.stringify(duplicateConsumerDir)};

const expectations = [
  ["runtime.loadRuntimeConfig", runtime.loadRuntimeConfig],
  ["config.loadRuntimeConfig", config.loadRuntimeConfig],
  ["composition.createDefaultRuntimeDependencies", composition.createDefaultRuntimeDependencies],
  ["defaultAdapters.createDefaultRuntimeHost", defaultAdapters.createDefaultRuntimeHost],
  ["adapters.createFileSessionStore", adapters.createFileSessionStore],
  ["adapters.createInMemorySessionStore", adapters.createInMemorySessionStore],
  ["adapters.createMultiWorkspaceProvider", adapters.createMultiWorkspaceProvider],
  ["adapters.createSourceWorkspaceProvider", adapters.createSourceWorkspaceProvider],
  ["adapters.createCompiledWorkspaceProvider", adapters.createCompiledWorkspaceProvider],
  ["modelGateway.createModelProviderAdapterRegistry", modelGateway.createModelProviderAdapterRegistry],
  ["modelGateway.createModelGatewayServer", modelGateway.createModelGatewayServer],
  ["pluginSdk.defineRuntimePlugin", pluginSdk.defineRuntimePlugin],
  ["pluginSdk.resolvePluginPath", pluginSdk.resolvePluginPath],
  ["pluginSdk.successResult", pluginSdk.successResult],
];

for (const [name, value] of expectations) {
  if (typeof value !== "function") {
    throw new Error(name + " was not exported as a function");
  }
}

if (Object.keys(ports).length !== 0) {
  throw new Error("runtime/ports should expose type-only exports at runtime");
}

delete process.env.BRAVE_SEARCH_API_KEY;
const runtimeConfig = config.loadRuntimeConfig({
  rootDir: consumerRoot,
  env: { LLM_RUNTIME_CONFIG_FILE: "local/runtime.config.json" },
});
const toolRegistry = defaultAdapters.createDefaultToolRegistry(runtimeConfig);
const loadedCapabilities = toolRegistry.listDefinitions().map(({ name }) => name).sort();
const expectedConfiguredCapabilities = [...expectedPublicCapabilities, "consumer_probe"].sort();
if (
  loadedCapabilities.length !== expectedConfiguredCapabilities.length ||
  loadedCapabilities.some((name, index) => name !== expectedConfiguredCapabilities[index])
) {
  throw new Error(
    "packed configured tool registry did not merge bundled and consumer plugin capabilities; expected=" +
      expectedConfiguredCapabilities.join(",") +
      "; received=" +
      loadedCapabilities.join(","),
  );
}
if (!loadedCapabilities.includes("web_fetch")) {
  throw new Error("packed configured tool registry did not expose web_fetch without a Brave key");
}
if (!loadedCapabilities.includes("web_search")) {
  throw new Error("packed configured tool registry did not expose web_search without a Brave key");
}

${createPackedWebSearchProbe()}
${createPackedSystemToolsProbe()}

const duplicateConfig = config.loadRuntimeConfig({
  rootDir: duplicateConsumerRoot,
  env: { LLM_RUNTIME_CONFIG_FILE: "local/runtime.config.json" },
});
let duplicateRejected = false;
try {
  defaultAdapters.createDefaultToolRegistry(duplicateConfig);
} catch (error) {
  duplicateRejected = /Duplicate runtime plugin id: web/.test(String(error));
}
if (!duplicateRejected) {
  throw new Error("packed configured tool registry did not fail closed on a duplicate bundled plugin id");
}
`,
  );

  execFileSync("node", [smokeFile], {
    cwd: consumerDir,
    env: { ...process.env, BRAVE_SEARCH_API_KEY: "" },
    stdio: "pipe",
  });

  await runPackedLocalRuntimeProbe({
    consumerDir,
    cliPath,
    reserveLoopbackPort,
    waitForHttp,
    stopChild,
  });

  console.log(
    "packed runtime package, CLI, system tools, Web UI, and shared local Runtime ok",
  );
} finally {
  await rm(tempDir, { force: true, recursive: true });
}
