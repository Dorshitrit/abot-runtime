import { readFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import createExecPlugin from "../../../plugins/exec/source/index.js";

import { createToolRegistry } from "../../capabilities/registry.js";
import { validateToolModuleDeclarations } from "../../capabilities/tool-definition-validator.js";
import { createRegisteredToolWorkerCapabilityProvider } from "../adapters/registered-tool-worker-capabilities.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import type {
  RuntimePluginEntrypoint,
  RuntimePluginLoadContext,
  ToolExecutionContext,
} from "../plugin.js";
import type { RuntimePaths, ToolRegistry } from "../ports.js";
import { ABOT_RUNTIME_EXTENSION } from "../../plugin-contract/manifest.js";
import { parseAgentPluginManifest } from "../plugins/manifest-validator.js";

const rootDir = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createRuntimePaths(): Promise<RuntimePaths> {
  const root = await mkdtemp(join(tmpdir(), "exec-agent-plugin-"));
  temporaryRoots.push(root);
  const runtimePaths = {
    rootDir: root,
    runtimeDir: join(root, ".runtime"),
    agentWorkDir: join(root, "agent-work"),
    sessionsDir: join(root, ".runtime", "sessions"),
    attachmentsDir: join(root, ".runtime", "attachments"),
    workspaceDir: join(root, "workspace"),
    sharedDir: join(root, "shared"),
    compiledDir: join(root, "compiled"),
    traceFile: join(root, ".runtime", "trace.ndjson"),
  };
  await Promise.all(
    Object.values(runtimePaths)
      .filter(
        (directory) => directory !== root && !directory.endsWith(".ndjson"),
      )
      .map((directory) => mkdir(directory, { recursive: true })),
  );
  return runtimePaths;
}

function loadManifest() {
  const raw = JSON.parse(
    readFileSync(join(rootDir, "plugins", "exec", "plugin.json"), "utf8"),
  ) as unknown;
  return parseAgentPluginManifest(raw, "exec");
}

function loadPlugin(
  runtimePaths: RuntimePaths,
  config?: Readonly<Record<string, unknown>>,
): RuntimePluginEntrypoint {
  const pluginRoot = join(rootDir, "plugins", "exec");
  const context: RuntimePluginLoadContext & Readonly<{ pluginRoot: string }> = {
    id: "exec",
    path: join(pluginRoot, "plugin.json"),
    stateDir: join(runtimePaths.runtimeDir, "plugins", "exec"),
    rootDir: runtimePaths.rootDir,
    runtimeId: "exec-plugin-test",
    agentBridgeUrl: "ws://127.0.0.1/unused",
    pluginRoot,
    runtimePaths,
    runtimePathResolver: createRuntimeToolPathResolver(runtimePaths),
    ...(config ? { config } : {}),
  };
  return createExecPlugin(context);
}

describe("exec Agent Plugin parity", () => {
  test("owns all exec-family declarations, payload contracts and grounding", () => {
    const extension = loadManifest().extensions[ABOT_RUNTIME_EXTENSION];
    const capabilities = extension.capabilities;

    expect(Object.keys(capabilities)).toEqual([
      "exec",
      "exec_wait",
      "exec_cancel",
    ]);
    expect(extension.settings?.defaults).toEqual({
      timeoutMs: 600_000,
      yieldAfterMs: 15_000,
      idleTimeoutMs: 120_000,
      outputMaxChars: 8_000,
    });
    expect(Object.keys(capabilities.exec.operations)).toEqual([
      "execute_command",
    ]);
    expect(Object.keys(capabilities.exec_wait.operations)).toEqual([
      "wait_for_process",
    ]);
    expect(Object.keys(capabilities.exec_cancel.operations)).toEqual([
      "cancel_process",
    ]);
    expect(capabilities.exec.skills).toEqual(["exec_skill"]);
    expect(capabilities.exec.runtimePathBindings).toBeUndefined();
    expect(capabilities.exec.operations.execute_command).toMatchObject({
      effect: "mixed",
      approval: "request_policy",
    });
  });

  test("projects every manifest operation through the canonical tool validator", async () => {
    const runtimePaths = await createRuntimePaths();
    const plugin = loadPlugin(runtimePaths);
    const extension = loadManifest().extensions[ABOT_RUNTIME_EXTENSION];
    const declarations = Object.entries(extension.capabilities).map(
      ([capabilityId, capability]) => ({
        definition: {
          name: capabilityId,
          description: capability.description,
          routingCapability: capability.routingCapability,
          ...(capability.developmentRoles
            ? { developmentRoles: [...capability.developmentRoles] }
            : {}),
          ...(capability.eventPresentation
            ? { eventPresentation: capability.eventPresentation }
            : {}),
          ...(capability.payloadChannelSpec
            ? { payloadChannelSpec: capability.payloadChannelSpec }
            : {}),
        },
        normalInvocation: {
          version: 1 as const,
          operations: Object.entries(capability.operations).map(
            ([operationId, operation]) => ({
              operationId,
              summary: operation.summary,
              input: operation.input,
              effect: operation.effect,
              approval: operation.approval,
              ...(operation.fixedParams
                ? { fixedParams: operation.fixedParams }
                : {}),
              ...(operation.payload ? { payload: operation.payload } : {}),
            }),
          ),
        },
        implementation: plugin.handlers[capabilityId]!,
        ...(plugin.adapters?.[capabilityId]
          ? { adapter: plugin.adapters[capabilityId] }
          : {}),
      }),
    );

    expect(validateToolModuleDeclarations(declarations)).toHaveLength(3);

    const canonicalRegistry = createToolRegistry({ modules: declarations });
    const registry: ToolRegistry = {
      listDefinitions: canonicalRegistry.getDefinitions,
      listNormalInvocations: canonicalRegistry.getNormalInvocations,
      getDefinition: canonicalRegistry.getByName,
      hasToolsAvailable: canonicalRegistry.hasToolsAvailable,
      getImplementations: canonicalRegistry.getImplementations,
      execute: async () => {
        throw new Error("descriptor projection must not execute a tool");
      },
    };
    const provider = createRegisteredToolWorkerCapabilityProvider({
      getRequestToolRegistry: () => registry,
      requestId: "exec-descriptor-contract",
      sessionId: "exec-descriptor-contract",
      abortSignal: new AbortController().signal,
      toolPermissionMode: "full_access",
      nextApprovalId: () => "approval-unused",
    });
    const descriptor = provider
      .getDescriptors()
      .find(({ capabilityId }) => capabilityId === "execute_command");

    expect(descriptor?.controls.properties.command).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 4_096,
    });
    expect(descriptor?.controls.properties.cwd).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 4_096,
    });
  });

  test("roots relative execution in agent work and workspace while reporting logical cwd", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths);

    await expect(
      handlers.exec?.({ command: "printf agent > agent.txt", cwd: "." }),
    ).resolves.toMatchObject({
      ok: true,
      data: { mutationEvidence: true },
    });
    await expect(
      handlers.exec?.({
        command: "printf workspace > workspace.txt",
        cwd: "workspace",
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { mutationEvidence: true },
    });
    await expect(
      readFile(join(runtimePaths.agentWorkDir, "agent.txt"), "utf8"),
    ).resolves.toBe("agent");
    await expect(
      readFile(join(runtimePaths.workspaceDir, "workspace.txt"), "utf8"),
    ).resolves.toBe("workspace");
    const logical = await handlers.exec?.({
      command: "printf visible",
      cwd: ".",
    });
    expect(logical?.output).toContain("CWD: .");
    expect(logical?.output).not.toContain(runtimePaths.agentWorkDir);
    await expect(
      handlers.exec?.({ command: "pwd", cwd: ".." }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_outside_configured_roots",
    });
  });

  test("rejects a cwd whose configured-root entry is a symlink escape", async () => {
    const runtimePaths = await createRuntimePaths();
    const outsideRoot = join(runtimePaths.rootDir, "outside");
    await mkdir(outsideRoot, { recursive: true });
    await symlink(
      outsideRoot,
      join(runtimePaths.agentWorkDir, "escape"),
      "dir",
    );
    const { handlers } = loadPlugin(runtimePaths);

    await expect(
      handlers.exec?.({ command: "pwd", cwd: "escape" }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "runtime_tool_path_symlink_escape",
    });
  });

  test("bootstraps a new project from the explicit agent root and rejects a missing cwd", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths);
    const projectPath = join(runtimePaths.agentWorkDir, "NewProject");
    const markerPath = join(projectPath, "marker.txt");

    const created = await handlers.exec?.({
      command: "mkdir -p NewProject && printf ready > NewProject/marker.txt",
      cwd: ".",
    });
    expect(created).toMatchObject({
      ok: true,
      data: { mutationEvidence: true },
    });
    expect(created?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "mkdir", target: "NewProject" }),
        expect.objectContaining({
          type: "write_file",
          target: "NewProject/marker.txt",
        }),
      ]),
    );
    expect(
      created?.actions?.map(({ target }) => target ?? "").join("\n"),
    ).not.toContain(runtimePaths.agentWorkDir);
    await expect(readFile(markerPath, "utf8")).resolves.toBe("ready");

    await expect(
      handlers.exec?.({
        command: "pwd",
        cwd: "MissingProject",
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "exec_cwd_not_found",
    });
    await expect(
      access(join(runtimePaths.agentWorkDir, "MissingProject")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects commands above the canonical control bound without side effects", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths);
    const expectedFiles = [
      { name: "index.html", content: `<main>${"I".repeat(1_200)}</main>` },
      { name: "style.css", content: `body{${"S".repeat(1_200)}}` },
      {
        name: "app.js",
        content: `export default ${JSON.stringify("J".repeat(1_200))};`,
      },
      { name: "README.md", content: `# Runtime\n${"R".repeat(1_200)}` },
    ] as const;
    const command = expectedFiles
      .map(
        ({ name, content }, index) =>
          `cat > ${name} <<'ABOT_FILE_${index}'\n${content}\nABOT_FILE_${index}`,
      )
      .join("\n");

    expect(command.length).toBeGreaterThan(4_096);
    await expect(handlers.exec?.({ command, cwd: "." })).resolves.toMatchObject(
      {
        ok: false,
        errorCode: "plugin_parameter_invalid",
      },
    );
    for (const { name } of expectedFiles) {
      await expect(
        access(join(runtimePaths.agentWorkDir, name)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  test("preserves running process continuation and cancellation", async () => {
    const runtimePaths = await createRuntimePaths();
    const { handlers } = loadPlugin(runtimePaths, {
      timeoutMs: 5_000,
      yieldAfterMs: 25,
      idleTimeoutMs: 5_000,
      outputMaxChars: 8_000,
    });
    const context: ToolExecutionContext = {
      sharedState: {
        currentSessionId: "exec-process-test",
      },
    };

    const running = await handlers.exec?.(
      { command: "sleep 0.08; printf ready", cwd: "." },
      context,
    );
    expect(running).toMatchObject({
      ok: false,
      errorCode: "exec_process_running",
      data: { processStatus: "running", nextCursor: 1 },
    });
    const processId = (running?.data?.processId as string) ?? "";
    const stdoutChunks = [running?.stdout ?? ""];
    const deadline = Date.now() + 5_000;
    let completed = running;
    while (
      completed?.errorCode === "exec_process_running" &&
      Date.now() < deadline
    ) {
      completed = await handlers.exec_wait?.(
        {
          process_id: processId,
          cursor: completed.data?.nextCursor,
        },
        context,
      );
      stdoutChunks.push(completed?.stdout ?? "");
    }
    expect(completed).toMatchObject({
      ok: true,
      exitCode: 0,
      data: { processStatus: "completed" },
    });
    expect(stdoutChunks.join("\n")).toContain("ready");

    const cancellable = await handlers.exec?.(
      { command: "sleep 5", cwd: "." },
      context,
    );
    await expect(
      handlers.exec_cancel?.(
        { process_id: (cancellable?.data?.processId as string) ?? "" },
        context,
      ),
    ).resolves.toMatchObject({
      ok: true,
      progress: true,
      exitCode: 130,
      data: { processStatus: "cancelled" },
    });
  });
});
