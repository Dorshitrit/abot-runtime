import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ToolFileOutputReport } from "../../capabilities/file-output-presentation.js";
import { executeToolCall } from "../../capabilities/tool-executor.js";
import type { RegisteredToolNormalInvocation } from "../../capabilities/tool-types.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations.js";
import { createRuntimeToolPathResolver } from "../capabilities/runtime-target-path.js";
import { createFilesystemPathService } from "../../../plugins/filesystem/source/path-service.js";
import { getProcessFilesystemMutationCoordinator } from "../../../plugins/filesystem/source/mutation-coordinator.js";
import { createWriteFileHandler } from "../../../plugins/filesystem/source/write-file.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { canViewConversationFile } from "../../web-ui/app/lib/conversation-file-reference.js";
import {
  createConversationFileFixture,
  type ConversationFileFixture,
} from "./support/conversation-file-test-fixture.js";

const registration: RegisteredToolNormalInvocation = {
  toolName: "write_file",
  definition: {
    name: "write_file",
    routingCapability: "filesystem_mutation",
    executionEffect: "mutating",
    params: { path: "string", content: "string" },
    eventPresentation: {
      metadata: { path: { param: "path", kind: "string" } },
    },
  },
  contract: {
    version: 1,
    operations: [
      {
        operationId: "write_file",
        summary: "Write a file.",
        effect: "mutating",
        approval: "request_policy",
        input: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4096 },
            content: { type: "string", minLength: 1, maxLength: 4096 },
          },
          required: ["path", "content"],
        },
      },
    ],
  },
};

let fixture: ConversationFileFixture;

beforeEach(async () => {
  vi.stubEnv("LLM_RUNTIME_TRACE", "0");
  fixture = await createConversationFileFixture();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture.close();
});

async function writeThroughRuntime(
  content: string,
  executionId = "execution",
  options: {
    path?: string;
    beforeExecute?: () => void;
    beforeReport?: (report: ToolFileOutputReport) => void;
  } = {},
) {
  const resolver = createRuntimeToolPathResolver(fixture.paths);
  const write = createWriteFileHandler(
    createFilesystemPathService(resolver),
    getProcessFilesystemMutationCoordinator(),
  );
  const events: Record<string, unknown>[] = [];
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: [registration],
    requestId: "request",
    sharedState: { runtimePaths: fixture.paths },
    abortSignal: new AbortController().signal,
    toolPermissionMode: "full_access",
    nextApprovalId: () => "unused",
    onEvent: (name, payload) =>
      events.push({ type: "event", name, requestId: "request", ...payload }),
    toolRegistry: {
      execute: (call, executionOptions) => {
        options.beforeExecute?.();
        return executeToolCall(call, {
          ...executionOptions,
          reportFileOutput: (report) => {
            options.beforeReport?.(report);
            executionOptions?.reportFileOutput?.(report);
          },
          runtimePathResolver: resolver,
          implementations: { write_file: write },
        });
      },
    },
  });
  const invocation = executor.prepare({
    handle: executor.operations[0]!.handle,
    controls: { path: options.path ?? "result.md", content },
  });
  if (invocation.status !== "prepared")
    throw new Error("Fixture invocation was not prepared");
  const result = await invocation.execute(executionId);
  for (const event of events)
    await fixture.sessions.appendRequestEvent("chat", "request", event);
  return { result, events };
}

test("real mutation -> completion -> persisted activity -> current file HTTP round trip", async () => {
  const original = "# Result\n\nשלום מהסוכן\n";
  const { result, events } = await writeThroughRuntime(original);
  expect(result).toMatchObject({ status: "executed", result: { ok: true } });
  expect(JSON.stringify(result)).not.toContain("fileOutput");
  expect(
    await readFile(join(fixture.paths.agentWorkDir, "result.md"), "utf8"),
  ).toBe(original);

  const live = buildConversationToolActions({ requestId: "request", events });
  const replay = await fixture.sessions.getRequestReplayById("request");
  const restored = buildConversationToolActions({
    requestId: "request",
    events: replay!.events,
  });
  expect(live).toHaveLength(1);
  expect(restored).toEqual(live);
  expect(canViewConversationFile(restored[0]!, "request")).toBe(true);
  expect(restored[0]!.fileReference).toMatchObject({
    requestId: "request",
    executionId: "execution",
    output: { logicalPath: "result.md", operation: "created" },
  });

  const response = await fixture.read();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    file: { name: "result.md", kind: "text", content: original },
  });
  const historicalAction = JSON.stringify(restored[0]);
  const current = "# Updated locally\n\nThe viewer reads this version.\n";
  await writeFile(join(fixture.paths.agentWorkDir, "result.md"), current);
  expect(await (await fixture.read()).json()).toMatchObject({
    file: { content: current },
  });
  expect(await (await fixture.read({ download: "1" })).text()).toBe(current);
  expect(JSON.stringify(restored[0])).toBe(historicalAction);

  await unlink(join(fixture.paths.agentWorkDir, "result.md"));
  expect((await fixture.read()).status).toBe(404);
});

test("unchanged writes expose neither a new UI action nor a retrievable output", async () => {
  await writeThroughRuntime("same contents");
  const { events } = await writeThroughRuntime("same contents", "unchanged");
  const actions = buildConversationToolActions({
    requestId: "request",
    events,
  });
  expect(actions).toHaveLength(1);
  expect(canViewConversationFile(actions[0]!, "request")).toBe(false);
  expect((await fixture.read({ executionId: "unchanged" })).status).toBe(404);
});

test.each(["agent_work", "workspace"])(
  "a committed write cannot expose a replacement %s root before reporting",
  async (location) => {
    const rootPath =
      location === "agent_work"
        ? fixture.paths.agentWorkDir
        : fixture.paths.workspaceDir;
    const movedRoot = rootPath + "-committed";
    let reported = false;
    const { result, events } = await writeThroughRuntime(
      "committed content",
      "execution",
      {
        path: location === "agent_work" ? "result.md" : "workspace/result.md",
        beforeReport: () => {
          reported = true;
          renameSync(rootPath, movedRoot);
          mkdirSync(rootPath);
          writeFileSync(join(rootPath, "result.md"), "unrelated replacement");
        },
      },
    );
    expect(reported).toBe(true);
    expect(result).toMatchObject({ status: "executed", result: { ok: true } });
    expect(await readFile(join(movedRoot, "result.md"), "utf8")).toBe(
      "committed content",
    );
    expect(JSON.stringify(result)).not.toContain("rootIdentity");
    const actions = buildConversationToolActions({
      requestId: "request",
      events,
    });
    expect(actions).toHaveLength(1);
    expect(canViewConversationFile(actions[0]!, "request")).toBe(false);
    const response = await fixture.read({ download: "1" });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("unrelated replacement");
    expect(readdirSync(rootPath)).toEqual(["result.md"]);
  },
);

test.each(["agent_work", "workspace"])(
  "uses the actual mutation root when %s is replaced and restored before reporting",
  async (location) => {
    const rootPath =
      location === "agent_work"
        ? fixture.paths.agentWorkDir
        : fixture.paths.workspaceDir;
    const originalRoot = rootPath + "-original";
    const mutationRoot = rootPath + "-mutation";
    mkdirSync(mutationRoot);
    writeFileSync(join(rootPath, "result.md"), "unrelated original root");
    let reported = false;
    const { result, events } = await writeThroughRuntime(
      "committed in alternate root",
      "execution",
      {
        path: location === "agent_work" ? "result.md" : "workspace/result.md",
        beforeExecute: () => {
          renameSync(rootPath, originalRoot);
          renameSync(mutationRoot, rootPath);
        },
        beforeReport: () => {
          reported = true;
          renameSync(rootPath, mutationRoot);
          renameSync(originalRoot, rootPath);
        },
      },
    );
    expect(reported).toBe(true);
    expect(result).toMatchObject({ status: "executed", result: { ok: true } });
    expect(await readFile(join(mutationRoot, "result.md"), "utf8")).toBe(
      "committed in alternate root",
    );
    expect(await readFile(join(rootPath, "result.md"), "utf8")).toBe(
      "unrelated original root",
    );
    expect(JSON.stringify(result)).not.toContain("rootIdentity");
    const actions = buildConversationToolActions({
      requestId: "request",
      events,
    });
    expect(actions).toHaveLength(1);
    expect(canViewConversationFile(actions[0]!, "request")).toBe(false);
    expect((await fixture.read()).status).toBe(404);
    expect(readdirSync(rootPath)).toEqual(["result.md"]);
  },
);
