import { writeFile } from "node:fs/promises";
import { expect, vi } from "vitest";
import { withSupervisorPreparation } from "./supervisor-model-phases.js";
import type WebSocket from "ws";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { createInMemorySessionStore } from "../../adapters/in-memory-session-store.js";
import type { RequestExecutionPolicyId } from "../../config/model-execution-policy.js";
import { RUNTIME_FILESYSTEM_SCOPE_KIND } from "../../context/runtime-filesystem-scope.js";
import { createDefaultToolRegistry } from "../../default-adapters.js";
import type {
  ModelGatewayClient,
  RuntimeConfig,
  ToolRegistry,
} from "../../ports.js";
import { handleRunRequest } from "../../request/handler.js";
import { createProjectFixture } from "./project-fixture.js";

export type FilesystemModelInput = Parameters<ModelGatewayClient["invoke"]>[0];
export type FilesystemScriptCall = Readonly<{
  step: FilesystemModelInput["modelStep"];
  format?: string;
  output: string | ((input: FilesystemModelInput) => string);
}>;

export function decision(value: unknown): string {
  return JSON.stringify({ decision: value });
}

export function messages(input: FilesystemModelInput): readonly ChatMessage[] {
  return input.messages as readonly ChatMessage[];
}

export function capsules(
  input: FilesystemModelInput,
  kind: string,
): Array<Record<string, unknown> & { role: ChatMessage["role"] }> {
  return messages(input).flatMap((message) => {
    try {
      const data = JSON.parse(message.content) as Record<string, unknown>;
      return data.kind === kind ? [{ ...data, role: message.role }] : [];
    } catch {
      return [];
    }
  });
}

export function assertFilesystemScope(
  input: FilesystemModelInput,
  root: string,
  workingDirectory: string | null,
  canSelectWorkingDirectory: boolean,
) {
  expect(capsules(input, RUNTIME_FILESYSTEM_SCOPE_KIND)).toEqual([
    expect.objectContaining({
      role: "system",
      authority: "canonical_runtime_state",
      provenance: "request_bound_agent_work_directory",
      agentWorkRoot: root,
      hostPathSyntax: process.platform === "win32" ? "win32" : "posix",
      workingDirectory,
      applicability: expect.objectContaining({ canSelectWorkingDirectory }),
    }),
  ]);
}

export async function filesystemScopeFixture(
  policy: RequestExecutionPolicyId,
  capacity = 32_000,
) {
  const base = await createProjectFixture();
  const config: RuntimeConfig = {
    ...base.config,
    paths: { ...base.config.paths, rootDir: process.cwd() },
    logging: {
      enabled: false,
      rotation: { maxFileSizeMb: 1, maxFiles: 1, maxAgeDays: 1 },
    },
    plugins: { enabled: true, allow: ["filesystem.write_file"] },
    models: {
      defaults: { profileId: "scripted" },
      providers: { injected: { type: "openai" } },
      profiles: {
        scripted: {
          provider: "injected",
          model: "scripted",
          contextWindowTokens: capacity,
        },
      },
    },
    modelExecutionPolicies: { scripted: { policy } },
  };
  await writeFile(
    config.requestRunner.configPath,
    JSON.stringify({
      schemaVersion: 2,
      models: { defaults: { profileId: "scripted", steps: {} } },
      context: {
        outputReserveTokens: 1000,
        safetyReserveTokens: 200,
        attachmentReserveTokens: 100,
      },
      stepDefaults: { timeoutMs: 5000 },
      steps: {},
    }),
  );
  const sessions = createInMemorySessionStore();
  await sessions.getOrCreateSession("filesystem-session");
  await sessions.updateSessionTitle(
    "filesystem-session",
    "Established fixture",
  );
  const registry = createDefaultToolRegistry(config);
  const events: Record<string, unknown>[] = [];
  return {
    ...base,
    config,
    sessions,
    registry,
    events,
    script(
      calls: readonly FilesystemScriptCall[],
      inspect?: (input: FilesystemModelInput) => void,
    ) {
      let index = 0;
      const invoke = vi.fn<ModelGatewayClient["invoke"]>(withSupervisorPreparation(async (input) => {
        const next = calls[index++];
        expect(
          next,
          `unexpected model step ${input.modelStep} at ${index}`,
        ).toBeDefined();
        expect(input.modelStep, JSON.stringify(messages(input).slice(-2))).toBe(
          next!.step,
        );
        if (next!.format)
          expect(input.format).toMatchObject({ name: next!.format });
        inspect?.(input);
        const text =
          typeof next!.output === "function"
            ? next!.output(input)
            : next!.output;
        return { text, meta: {} };
      }));
      const model: ModelGatewayClient = {
        invoke,
        invokeRaw: vi.fn(async () => {
          throw new Error("unexpected_raw_gateway_call");
        }),
        countInputTokens: vi.fn<
          NonNullable<ModelGatewayClient["countInputTokens"]>
        >(async () => ({
          inputTokens: 1000,
          profileId: "scripted",
          provider: "openai",
          model: "scripted",
          contextWindowTokens: capacity,
          source: "provider_input_token_count",
        })),
      };
      return {
        model,
        invoke,
        assertComplete: () => {
          expect(events.filter((event) => event.type === "failed")).toEqual([]);
          expect(index).toBe(calls.length);
        },
      };
    },
    run(model: ModelGatewayClient, tools: ToolRegistry = registry) {
      return handleRunRequest(
        {
          send: (data: string) => events.push(JSON.parse(data)),
        } as unknown as WebSocket,
        {
          type: "run_request",
          requestId: "filesystem-request",
          sessionId: "filesystem-session",
          input:
            "Create LUNA/index.html with the exact provided content under the runtime work root.",
          agentMode: "reasoning",
          toolPermissionMode: "full_access",
          modelPreference: { profileId: "scripted", scope: "all" },
        },
        {
          runtimeConfig: config,
          sessionStore: sessions,
          toolRegistry: tools,
          modelGatewayClient: model,
          toolApprovalController: {
            requestToolApproval: async () => ({ approved: true }),
          },
        },
      );
    },
  };
}
