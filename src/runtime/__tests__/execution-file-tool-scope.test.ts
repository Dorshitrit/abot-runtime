import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import type { CapabilityDescriptor } from "../orchestration/capability-adapters/index.js";
import { EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX, type ExecutionAgentDecisionContractOptions } from "../steps/execution-agent/contracts.js";
import { parseExecutionAgentDecisionOutput } from "../steps/execution-agent/parser.js";
import { routeFilePayloadAuthor } from "../request/execution-file-payload/author.js";
import { buildFilePayloadTools, parseFilePayloadToolSelection } from "../request/execution-file-payload/tools.js";
import { resolveRequestExecutionPolicy } from "../request/role-executor-composition.js";
import { configureDebugLogger, resetDebugLoggerConfig } from "../observability/debug-logger.js";
import { filePayloadFixture, filePayloadInput } from "./support/execution-file-payload-fixture.js";
import { filePayloadOutput } from "./support/execution-file-output-fixture.js";

function capability(capabilityId: string, effect: CapabilityDescriptor["effect"],
  catalogGroups: CapabilityDescriptor["catalogGroups"] = ["read"]): CapabilityDescriptor {
  return {
    capabilityId, effect, catalogGroups, summary: `Synthetic operation ${capabilityId}.`,
    selectionControlIds: ["value"],
    controls: { type: "object", additionalProperties: false,
      properties: { value: { type: "string", minLength: 1 } }, required: ["value"] },
  };
}

const capabilities = [
  capability("alpha", "observation"), capability("beta", "mutation", ["write"]),
  capability("gamma", "mixed", ["write"]), capability("delta", "observation"),
];
const contract: ExecutionAgentDecisionContractOptions = {
  capabilities, allowRespond: false, maxBatchCapabilityExecutions: EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX,
};
const invocation = (capabilityId: string) => ({ capabilityId, selectionControls: { value: "input" } });
const selection = (capabilityId: string) => JSON.stringify({
  decision: { action: "invoke_capability", ...invocation(capabilityId) },
});
const batch = (...ids: string[]) => JSON.stringify({
  decision: { action: "invoke_capabilities", invocations: ids.map(invocation) },
});

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("one scoped observation catalog owns the offer, schema, guidance and parser", async () => {
  const input = filePayloadInput();
  const guidance = vi.fn((id: string) => `Guidance for ${id}.`);
  const tools = await buildFilePayloadTools({
    getDescriptors: () => [...capabilities, capability("outside", "observation", ["web"])],
    getExecutionGuidance: guidance,
  }, { ...input, call: { ...input.call, workerCapabilityScope: { catalogGroupIds: ["read", "write"] } } });
  expect(tools).toBeDefined();
  const offer = JSON.parse(tools!.message.content);
  expect(offer.capabilities.map(({ capabilityId }: CapabilityDescriptor) => capabilityId)).toEqual(["alpha", "delta"]);
  expect(guidance.mock.calls.map(([id]) => id)).toEqual(["alpha", "delta"]);
  for (const id of ["beta", "gamma", "outside"]) {
    expect(JSON.stringify(offer.decisionFormat)).not.toContain(`"${id}"`);
    expect(() => parseFilePayloadToolSelection(selection(id), tools!.contract)).toThrow("payload_model_output_invalid");
  }
  expect(parseFilePayloadToolSelection(selection("alpha"), tools!.contract)).toMatchObject({ capabilityId: "alpha" });
});

test.each(["beta", "gamma", "unavailable"])("a full caller contract cannot admit %s into RAW handoff", (id) => {
  expect(() => parseFilePayloadToolSelection(selection(id), contract)).toThrow("payload_model_output_invalid");
});

test.each(["beta", "gamma"])("ordinary EA selection still admits declared %s effects", (id) => {
  expect(parseExecutionAgentDecisionOutput(selection(id), contract)).toMatchObject({
    ok: true, decision: { action: "invoke_capability", capabilityId: id },
  });
});

test("observation batches remain available and a forbidden member rejects the whole batch", () => {
  expect(parseFilePayloadToolSelection(batch("alpha", "delta"), contract)).toMatchObject({
    action: "invoke_capabilities", invocations: [{ capabilityId: "alpha" }, { capabilityId: "delta" }],
  });
  for (const id of ["beta", "gamma", "unavailable"]) {
    expect(() => parseFilePayloadToolSelection(batch("alpha", id), contract)).toThrow("payload_model_output_invalid");
  }
});

test("an observation needing payload authoring remains eligible by its declared effect", async () => {
  const descriptor = { ...capability("authored_observation", "observation"), requiresPayloadAuthoringObjective: true as const };
  const tools = await buildFilePayloadTools({ getDescriptors: () => [descriptor] }, filePayloadInput());
  expect(tools!.contract.capabilities).toEqual([descriptor]);
  expect(parseFilePayloadToolSelection(JSON.stringify({ decision: {
    action: "invoke_capability", ...invocation(descriptor.capabilityId), operationObjective: "Obtain the requested information.",
  } }), tools!.contract)).toMatchObject({ capabilityId: descriptor.capabilityId });
});

test.each(["unknown", undefined])("an invalid effect %j cannot enter the author tool scope", async (effect) => {
  const descriptor = { ...capability("invalid", "observation"), effect } as unknown as CapabilityDescriptor;
  await expect(buildFilePayloadTools({ getDescriptors: () => [descriptor] }, filePayloadInput()))
    .rejects.toThrow("descriptor_invalid");
  expect(() => parseFilePayloadToolSelection(selection("invalid"), { capabilities: [descriptor] }))
    .toThrow("payload_model_output_invalid");
});

test("a known mutation-only active group has no tool offer without invalidating its scope", async () => {
  const input = filePayloadInput();
  await expect(buildFilePayloadTools({ getDescriptors: () => capabilities }, {
    ...input, call: { ...input.call, workerCapabilityScope: { catalogGroupIds: ["write"] } },
  })).resolves.toBeUndefined();
});

test.each(["write", "abort"] as const)("without observation tools, RAW %s remains available", async (outcome) => {
  const f = await filePayloadFixture();
  const body = outcome === "write" ? "EXACT_OUTPUT\r\n" : "A prerequisite change needs the Execution Agent.";
  f.invoke.mockImplementation(async (input) => {
    expect((input.messages as readonly ChatMessage[]).some(({ content }) => content.includes('"kind":"execution_file_tools_v1"'))).toBe(false);
    return { text: filePayloadOutput(input.messages, body, outcome), meta: {} };
  });
  const author = routeFilePayloadAuthor(f.request, { author: vi.fn() },
    resolveRequestExecutionPolicy("execution-agent-v1").authority,
    () => ({ getDescriptors: () => capabilities.filter(({ effect }) => effect !== "observation") }));
  const result = author.author(filePayloadInput());
  if (outcome === "abort") await expect(result).rejects.toMatchObject({ code: "payload_author_declined" });
  else await expect(result).resolves.toEqual({ status: "authored", body });
  expect(f.invoke).toHaveBeenCalledOnce();
});
