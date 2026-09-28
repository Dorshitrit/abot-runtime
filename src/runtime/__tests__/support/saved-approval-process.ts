import { readFile, appendFile } from "node:fs/promises";
import { createLocalRuntimeOwner } from "../../local-host/app-owner.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import type { RuntimeConfig } from "../../ports.js";
import type { LocalRuntimePeer } from "../../local-host/contracts.js";
import type { LocalPendingToolApproval } from "../../local-host/request-approval-contracts.js";
import { successResult } from "../../../plugin-sdk/index.js";

const [configPath, mode, effectPath] = process.argv.slice(2) as [
  string,
  string,
  string,
];
const config = JSON.parse(await readFile(configPath, "utf8")) as RuntimeConfig;
let turns = 0;
const model = {
  async invoke(input: { modelStep?: string }) {
    if (mode === "inspect") throw new Error("inspect_must_not_invoke_model");
    if (input.modelStep === "execution.response")
      return { text: "Done.", meta: {} };
    if (input.modelStep !== "execution.decision")
      throw new Error("unexpected_model_step");
    turns++;
    const decision =
      mode === "resume"
        ? { action: "respond" }
        : turns === 1
          ? {
              action: "open_capability_scope",
              catalogGroupIds: ["fixture"],
              acknowledgement: "Checking.",
            }
          : {
              action: "invoke_capability",
              capabilityId: "effect",
              intent: "Perform exactly one effect.",
              workingDirectory: ".",
            };
    return { text: JSON.stringify({ decision }), meta: {} };
  },
  async invokeRaw(): Promise<never> {
    throw new Error("raw_model_forbidden");
  },
};
const tools = createConfiguredToolRegistry(config, [
  {
    definition: {
      name: "fixture_effect",
      routingCapability: "semantic_mutation",
      catalogGroups: ["fixture"],
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: "effect",
          summary: "One effect.",
          effect: "mutating",
          approval: "request_policy",
          input: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
    },
    implementation: async () => {
      if (mode === "active") {
        process.send?.({ kind: "executing" });
        await new Promise(() => {});
      }
      await appendFile(effectPath, "effect\n");
      return successResult({ output: "Done." });
    },
  },
]);
const peer: LocalRuntimePeer = {
  id: "process-view",
  async callClient() {
    return null;
  },
  onClose() {
    return () => {};
  },
};
const owner = await createLocalRuntimeOwner(config, { models: model, tools });
if (mode === "park" || mode === "active") {
  const result = await owner.call(
    "request.run",
    [
      {
        type: "run_request",
        requestId: "process-request",
        sessionId: "session",
        text: "One effect.",
        agentMode: "reasoning",
        toolPermissionMode: mode === "active" ? "full_access" : "ask",
        modelPreference: { profileId: "scheduled-model", scope: "all" },
      },
      { durableApprovals: true, approvalAvailable: true },
    ],
    peer,
  );
  process.send?.({ kind: "parked", result, idle: owner.isIdle?.() });
  setInterval(() => {}, 1000);
} else {
  const pending = (await owner.call(
    "request.approvals",
    ["session"],
    peer,
  )) as LocalPendingToolApproval[];
  if (mode === "resume" && pending[0]) {
    const entry = pending[0];
    const command = {
      requestId: entry.request.requestId,
      sessionId: entry.sessionId,
      approvalId: entry.request.approvalId,
      ...entry.wait!,
      commandId: "process-decision",
      approved: true,
    };
    const result = await owner.call("request.approval.decide", [command], peer);
    await owner.whenIdle?.();
    process.send?.({ kind: "decided", result });
  }
  const session = await owner.call(
    "sessions.getSessionSnapshot",
    ["session"],
    peer,
  );
  process.send?.({ kind: "snapshot", session, pending });
  await owner.stop();
  await owner.whenIdle?.();
  process.disconnect?.();
}
