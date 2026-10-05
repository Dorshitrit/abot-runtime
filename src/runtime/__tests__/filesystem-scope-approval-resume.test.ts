import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../capabilities/tool-types.js";
import { successResult } from "../../plugin-sdk/index.js";
import { createSessionContinuationBlobs } from "../../sessions/request-lifecycle/continuation-blobs.js";
import type { SessionRecord } from "../../sessions/types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { RUNTIME_FILESYSTEM_SCOPE_KIND } from "../context/runtime-filesystem-scope.js";
import { createLocalRuntimeOwner } from "../local-host/app-owner.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { RuntimeConfig } from "../ports.js";
import { createExecApprovalScript } from "./support/exec-sensitive-approval-script.js";
import {
  assertFilesystemScope,
  capsules,
  filesystemScopeFixture,
} from "./support/filesystem-scope-integration-fixture.js";
import { makeOwnerControlPeer } from "./support/local-runtime-owner-peer.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each(["execution-agent-v1", "supervisor-worker-v1"] as const)(
  "%s restores the frozen root after a JSON snapshot and owner restart with changed configured root; executes once",
  async (policy) => {
    const fixture = await filesystemScopeFixture(policy);
    const originalRoot = fixture.config.paths.agentWorkDir;
    const laterRoot = fixture.directories[2]!;
    await mkdir(join(originalRoot, "LUNA"));
    await mkdir(join(laterRoot, "LUNA"));
    const execute = vi.fn<ToolModuleDeclaration["implementation"]>(
      async (params, context) => {
        const target = context!.runtimePathResolver!.resolve(
          String(params.path),
          {
            allowedLocations: ["agent_work"],
            requirePath: true,
          },
        );
        await writeFile(target.absolutePath, "exact approved body", {
          flag: "wx",
        });
        return successResult({ output: "Created the exact requested file." });
      },
    );
    const module: ToolModuleDeclaration = {
      definition: {
        name: "write_fixture",
        routingCapability: "filesystem_mutation",
        catalogGroups: ["write"],
        runtimePathBindings: [
          {
            operationId: "save_file",
            param: "path",
            base: "worker_working_directory",
          },
        ],
      },
      normalInvocation: {
        version: 1,
        operations: [
          {
            operationId: "save_file",
            summary: "Write an exact test marker under the runtime root.",
            effect: "mutating",
            approval: "request_policy",
            input: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string", minLength: 1, maxLength: 4096 },
              },
              required: ["path"],
            },
          },
        ],
      },
      implementation: execute,
    };
    const model = createExecApprovalScript(
      policy,
      [{ capabilityId: "save_file", controls: { path: "approved.txt" } }],
      "write",
    );
    const invoke = model.invoke.getMockImplementation()!;
    let rootEstablished = false;
    model.invoke.mockImplementation(async (input) => {
      const cwdPhase =
        typeof input.format === "object" &&
        input.format?.name === "supervisor_working_directory";
      if (cwdPhase) {
        assertFilesystemScope(input, originalRoot, null, true);
      } else if (
        input.modelStep === "capability.controls" ||
        input.modelStep === "worker.decision"
      ) {
        assertFilesystemScope(input, originalRoot, "LUNA", false);
      } else if (input.modelStep === "execution.decision") {
        const catalog = capsules(
          input,
          "runtime_execution_capability_catalog_v1",
        )[0];
        const available =
          (catalog?.capabilities as unknown[] | undefined)?.length ?? 0;
        if (available)
          assertFilesystemScope(
            input,
            originalRoot,
            rootEstablished ? "LUNA" : null,
            !rootEstablished,
          );
        else expect(capsules(input, RUNTIME_FILESYSTEM_SCOPE_KIND)).toEqual([]);
      } else expect(capsules(input, RUNTIME_FILESYSTEM_SCOPE_KIND)).toEqual([]);
      const result = await invoke(input);
      if (!cwdPhase && input.modelStep !== "execution.decision") return result;
      const parsed = JSON.parse(result.text);
      const selected = cwdPhase ? parsed : parsed.decision;
      if (Object.hasOwn(selected, "workingDirectory")) {
        selected.workingDirectory = "LUNA";
        rootEstablished = true;
      }
      return { ...result, text: JSON.stringify(parsed) };
    });
    const owners: Awaited<ReturnType<typeof createLocalRuntimeOwner>>[] = [];
    const events: Record<string, unknown>[] = [];
    const { peer } = makeOwnerControlPeer("filesystem-approval-view");
    async function start(config: RuntimeConfig) {
      const owner = await createLocalRuntimeOwner(config, {
        models: model,
        tools: createConfiguredToolRegistry(config, [module]),
      });
      owners.push(owner);
      owner.subscribe((event) => events.push(event as Record<string, unknown>));
      return owner;
    }
    try {
      const initial = await start(fixture.config);
      await initial.call(
        "sessions.getOrCreateSession",
        ["filesystem-session"],
        peer,
      );
      await initial.call(
        "sessions.updateSessionTitle",
        ["filesystem-session", "Established fixture"],
        peer,
      );
      const outcome = await initial.call(
        "request.run",
        [
          {
            type: "run_request",
            requestId: "frozen-root-request",
            sessionId: "filesystem-session",
            text: "Create the exact marker in LUNA/approved.txt after approval.",
            toolPermissionMode: "ask",
            agentMode: "reasoning",
            modelPreference: { profileId: "scripted", scope: "all" },
          },
          { durableApprovals: true, approvalAvailable: true },
        ],
        peer,
      );
      expect(events.filter((event) => event.type === "failed")).toEqual([]);
      expect(outcome).toMatchObject({ kind: "awaiting_approval" });
      expect(execute).not.toHaveBeenCalled();
      const pending = (await initial.call(
        "request.approvals",
        ["filesystem-session"],
        peer,
      )) as LocalPendingToolApproval[];
      expect(pending).toHaveLength(1);
      const session = (await initial.call(
        "sessions.getSessionById",
        ["filesystem-session"],
        peer,
      )) as SessionRecord;
      const continuation = session.requests!.find(
        (request) => request.requestId === "frozen-root-request",
      )!.lifecycle!.wait!.continuation;
      const snapshot = await createSessionContinuationBlobs(
        fixture.config.paths.sessionsDir,
      ).readContinuation("filesystem-session", continuation);
      expect(JSON.parse(JSON.stringify(snapshot))).toMatchObject({
        requestWorkingDirectory: originalRoot,
      });
      const beforeResume = model.invoke.mock.calls.length;
      await initial.stop();
      await initial.whenIdle?.();
      const resumed = await start({
        ...fixture.config,
        paths: { ...fixture.config.paths, agentWorkDir: laterRoot },
      });
      expect(
        await resumed.call("request.approvals", ["filesystem-session"], peer),
      ).toEqual(pending);
      expect(model.invoke).toHaveBeenCalledTimes(beforeResume);
      const command = {
        sessionId: "filesystem-session",
        requestId: "frozen-root-request",
        approvalId: pending[0]!.request.approvalId,
        ...pending[0]!.wait!,
        commandId: "approve-once",
        approved: true,
      };
      expect(
        await resumed.call("request.approval.decide", [command], peer),
      ).toEqual({ accepted: true });
      expect(
        await resumed.call("request.approval.decide", [command], peer),
      ).toEqual({ accepted: true, duplicate: true });
      await resumed.whenIdle?.();
      expect(execute).toHaveBeenCalledOnce();
      expect(
        await readFile(join(originalRoot, "LUNA", "approved.txt"), "utf8"),
      ).toBe("exact approved body");
      await expect(
        readFile(join(laterRoot, "LUNA", "approved.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        model.invoke.mock.calls.filter(
          ([input]) => input.modelStep === "capability.controls",
        ),
      ).toHaveLength(1);
      expect(
        await resumed.call("request.approvals", ["filesystem-session"], peer),
      ).toEqual([]);
      const completed = (await resumed.call(
        "sessions.getSessionById",
        ["filesystem-session"],
        peer,
      )) as SessionRecord;
      expect(
        completed.requests!.find(
          (request) => request.requestId === "frozen-root-request",
        )!.status,
      ).toBe("completed");
    } finally {
      for (const owner of owners.reverse()) {
        await owner.stop();
        await owner.whenIdle?.();
      }
      await fixture.close();
    }
  },
  20_000,
);
