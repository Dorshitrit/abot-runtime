import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type WebSocket from "ws";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import type { ModelGatewayClient } from "../ports.js";
import { handleRunRequest } from "../request/handler.js";
import {
  EXECUTION_CAPABILITY_CATALOG_MESSAGE_KIND as ACTIVE_KIND,
  EXECUTION_CAPABILITY_GROUP_CATALOG_MESSAGE_KIND as GROUP_KIND,
} from "../steps/execution-agent/state-context.js";
import {
  capsules,
  decision,
  filesystemScopeFixture,
  messages,
  type FilesystemModelInput,
} from "./support/filesystem-scope-integration-fixture.js";

type Fixture = Awaited<ReturnType<typeof filesystemScopeFixture>>;
const CAPABILITY_ID = "write_complete_file";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test.each(["LUNA/index.html", "LUNA/README"])(
  "projects the registered file summary once and writes %s directly through RAW",
  async (path) => {
    const fixture = await filesystemScopeFixture("execution-agent-v1");
    try {
      const { summary, description, operation } = writeMetadata(fixture);
      const body = "Exact requested file content.\n";
      const inputs: FilesystemModelInput[] = [];
      const scripted = fixture.script(
        [
          {
            step: "execution.decision",
            output: decision({
              action: "open_capability_scope",
              catalogGroupIds: ["write"],
              acknowledgement: "I will create the requested file.",
            }),
          },
          {
            step: "execution.decision",
            output: decision({
              action: "invoke_capability",
              capabilityId: CAPABILITY_ID,
              intent: "Create the requested file.",
              operationObjective: `Write exactly ${JSON.stringify(body)}.`,
              selectionControls: { path },
              workingDirectory: null,
            }),
          },
          { step: "tool_payload.raw", output: body },
          {
            step: "execution.decision",
            output: decision({ action: "respond" }),
          },
          { step: "execution.response", output: `Created ${path}.` },
        ],
        (input) => inputs.push(input),
      );

      expect(await readdir(fixture.config.paths.agentWorkDir)).toEqual([]);
      await run(
        fixture,
        scripted.model,
        `Create ${path} containing exactly ${JSON.stringify(body)}.`,
      );
      scripted.assertComplete();
      expect(inputs.map(({ modelStep }) => modelStep)).toEqual([
        "execution.decision",
        "execution.decision",
        "tool_payload.raw",
        "execution.decision",
        "execution.response",
      ]);

      for (const input of inputs.filter(
        ({ modelStep }) => modelStep === "execution.decision",
      )) {
        const groups = capsules(input, GROUP_KIND);
        expect(groups).toHaveLength(1);
        expect(occurrences(groups, summary)).toBe(1);
        const active = capsules(input, ACTIVE_KIND);
        expect(occurrences(active, summary)).toBe(0);
        expect(active.flatMap((capsule) => capsule.capabilities)).toEqual(
          input === inputs[0]
            ? []
            : [{ capabilityId: CAPABILITY_ID, effect: "mutation" }],
        );
      }

      const selection = invocationVariants(inputs[1]!).find(({ properties }) =>
        properties.capabilityId.enum.includes(CAPABILITY_ID),
      );
      expect(selection).toBeDefined();
      expect(selection!.properties.selectionControls).toEqual(operation.input);
      expect(operation.input).toEqual({
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1, maxLength: 4096 },
        },
        required: ["path"],
      });

      const raw = inputs[2]!;
      const prefix = "Canonical runtime context:\n";
      const canonical = messages(raw).filter(({ content }) =>
        content.startsWith(prefix),
      );
      expect(canonical).toHaveLength(1);
      const context = JSON.parse(canonical[0]!.content.slice(prefix.length));
      expect(context.acceptedCapability).toMatchObject({
        capabilityId: CAPABILITY_ID,
        summary,
        controls: { path },
      });
      expect(occurrences(context.acceptedCapability, summary)).toBe(1);
      expect(occurrences(messages(raw), summary)).toBe(1);
      for (const input of inputs) {
        expect(
          messages(input).some(({ content }) => content.includes(description)),
        ).toBe(false);
      }
      expect(
        await readFile(join(fixture.config.paths.agentWorkDir, path), "utf8"),
      ).toBe(body);
    } finally {
      await fixture.close();
    }
  },
);

test("an unrelated direct response does not select or author a filesystem operation", async () => {
  const fixture = await filesystemScopeFixture("execution-agent-v1");
  try {
    const { summary, description } = writeMetadata(fixture);
    const inputs: FilesystemModelInput[] = [];
    const scripted = fixture.script(
      [
        {
          step: "execution.decision",
          output: decision({
            action: "respond",
            acknowledgement: "I will answer the arithmetic question.",
          }),
        },
        { step: "execution.response", output: "Four." },
      ],
      (input) => inputs.push(input),
    );
    await run(fixture, scripted.model, "What is two plus two?");
    scripted.assertComplete();
    expect(inputs.map(({ modelStep }) => modelStep)).toEqual([
      "execution.decision",
      "execution.response",
    ]);
    expect(occurrences(capsules(inputs[0]!, GROUP_KIND), summary)).toBe(1);
    expect(capsules(inputs[0]!, ACTIVE_KIND)).toEqual([]);
    expect(occurrences(messages(inputs[1]!), summary)).toBe(0);
    expect(
      inputs
        .flatMap(messages)
        .some(({ content }) => content.includes(description)),
    ).toBe(false);
    expect(await readdir(fixture.config.paths.agentWorkDir)).toEqual([]);
  } finally {
    await fixture.close();
  }
});

function writeMetadata(fixture: Fixture) {
  const registration = fixture.registry.listNormalInvocations!().find(
    ({ toolName }) => toolName === "write_file",
  );
  expect(registration).toBeDefined();
  const operation = registration!.contract.operations.find(
    ({ operationId }) => operationId === CAPABILITY_ID,
  );
  expect(operation).toBeDefined();
  // This suite checks projection and execution, not instruction wording.
  // Review the manifest-owned guidance semantics without freezing prompt prose.
  const summary = operation!.summary;
  const description = registration!.definition.description!;
  expect(summary.trim()).not.toBe("");
  expect(description.trim()).not.toBe("");
  expect(description).not.toBe(summary);
  return { summary, description, operation: operation! };
}

function occurrences(value: unknown, text: string): number {
  return (
    JSON.stringify(value).split(JSON.stringify(text).slice(1, -1)).length - 1
  );
}

type InvocationVariant = {
  properties: {
    action: { enum: string[] };
    capabilityId: { enum: string[] };
    selectionControls?: unknown;
  };
};

function invocationVariants(input: FilesystemModelInput): InvocationVariant[] {
  const format = input.format as {
    schema: {
      properties: {
        decision: InvocationVariant & { anyOf?: InvocationVariant[] };
      };
    };
  };
  const schema = format.schema.properties.decision;
  return (schema.anyOf ?? [schema]).filter(({ properties }) =>
    properties.action.enum.includes("invoke_capability"),
  );
}

function run(fixture: Fixture, model: ModelGatewayClient, prompt: string) {
  return handleRunRequest(
    {
      send: (data: string) => fixture.events.push(JSON.parse(data)),
    } as unknown as WebSocket,
    {
      type: "run_request",
      requestId: "file-target-guidance-request",
      sessionId: "filesystem-session",
      input: prompt,
      agentMode: "reasoning",
      toolPermissionMode: "full_access",
      modelPreference: { profileId: "scripted", scope: "all" },
    },
    {
      runtimeConfig: fixture.config,
      sessionStore: fixture.sessions,
      toolRegistry: fixture.registry,
      modelGatewayClient: model,
      toolApprovalController: {
        requestToolApproval: async () => ({ approved: true }),
      },
    },
  );
}
