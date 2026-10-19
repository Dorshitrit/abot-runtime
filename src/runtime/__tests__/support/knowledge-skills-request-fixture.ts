import { expect, vi } from "vitest";
import type WebSocket from "ws";
import type { ChatMessage } from "../../../model-gateway/types.js";
import { validateModelGatewayMessages } from "../../../model-gateway/message-contract.js";
import type { RequestExecutionPolicyId } from "../../config/model-execution-policy.js";
import { createConfiguredToolRegistry } from "../../capabilities/configured-tool-registry.js";
import { createKnowledgeSkillsToolModule } from "../../capabilities/knowledge-skills/tool-module.js";
import { createKnowledgeSkillStore } from "../../knowledge-skills/store.js";
import {
  createSchedulerRuntimeFixture,
  type ScheduledModelInput,
} from "./scheduler-runtime-fixture.js";

export type KnowledgeModelInput = ScheduledModelInput;
export type KnowledgeScriptEntry = Readonly<{
  step: KnowledgeModelInput["modelStep"];
  output: string | ((input: KnowledgeModelInput) => string);
}>;

export const KNOWLEDGE_FIXTURE_DOCUMENTS = [
  {
    skillId: "abot-studio",
    name: "Fixture Studio handbook",
    description: "Fixture metadata for Studio authoring.",
    content: "STUDIO_BODY_7a3: Verify connected draft inputs before saving the inactive draft.",
  },
  {
    skillId: "computer-use",
    name: "Fixture Computer handbook",
    description: "Fixture metadata for screen interaction.",
    content: "COMPUTER_BODY_8b4: Inspect the current screen before choosing the next input.",
  },
] as const;

export const decision = (value: unknown) => JSON.stringify({ decision: value });

export function messages(input: KnowledgeModelInput): readonly ChatMessage[] {
  return input.messages as readonly ChatMessage[];
}

export function capsules(input: KnowledgeModelInput, kind: string) {
  return messages(input).flatMap(({ content }) => {
    try {
      const decoded = JSON.parse(content) as Record<string, unknown>;
      return decoded.kind === kind ? [decoded] : [];
    } catch {
      return [];
    }
  });
}

type CapabilityResult = {
  executionId: string;
  callId?: string;
  capabilityId: string;
  outcome: string;
  adapterResult?: {
    kind: string;
    result: { ok: boolean; output: string };
  };
};

export function capabilityResults(input: KnowledgeModelInput): CapabilityResult[] {
  const native = capsules(input, "runtime_execution_capability_result_v1");
  if (native.length > 0) return native.map(({ result }) => result as CapabilityResult);
  return capsules(input, "runtime_request_tool_results_v1")
    .flatMap(({ results }) => results as CapabilityResult[]);
}

export function exactSkillOutput(input: KnowledgeModelInput, capabilityId: string) {
  const result = capabilityResults(input)
    .filter((entry) => entry.capabilityId === capabilityId).at(-1);
  expect(result, JSON.stringify(messages(input).slice(-2))).toMatchObject({
    outcome: "succeeded",
    adapterResult: { kind: "registered_tool_execution_result_v1", result: { ok: true } },
  });
  return JSON.parse(result!.adapterResult!.result.output) as Record<string, unknown>;
}

export async function createKnowledgeSkillsRequestFixture(policy: RequestExecutionPolicyId) {
  const source = createKnowledgeSkillStore(KNOWLEDGE_FIXTURE_DOCUMENTS);
  const store = { list: vi.fn(source.list), read: vi.fn(source.read) };
  const module = createKnowledgeSkillsToolModule(store);
  const implementation = vi.fn(module.implementation);
  const registry = createConfiguredToolRegistry(undefined, [{ ...module, implementation }]);
  const fixture = await createSchedulerRuntimeFixture(policy, undefined, registry, store);
  const events: Record<string, unknown>[] = [];

  return {
    ...fixture,
    store,
    implementation,
    async run(prompt: string, script: readonly KnowledgeScriptEntry[], finalAnswer: string) {
      let next = 0;
      let modelAssertion: unknown;
      fixture.invoke.mockImplementation(async (input) => {
        try {
          validateModelGatewayMessages(messages(input));
          const entry = script[next++];
          expect(entry, "unexpected_model_step:" + input.modelStep).toBeDefined();
          expect(input.modelStep).toBe(entry!.step);
          const text = typeof entry!.output === "string" ? entry!.output : entry!.output(input);
          return { text, meta: {} };
        } catch (error) {
          modelAssertion ??= error;
          throw error;
        }
      });
      await fixture.application.requests.handle({
        send(value: string) { events.push(JSON.parse(value)); },
      } as unknown as WebSocket, {
        type: "run_request",
        requestId: "knowledge-skills-request",
        sessionId: "session",
        text: prompt,
        agentMode: "reasoning",
        modelPreference: { profileId: "scheduled-model", scope: "all" },
        toolPermissionMode: "full_access",
      });
      if (modelAssertion) throw modelAssertion;
      expect(events.filter(({ type }) => type === "failed")).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({ type: "completed", output: finalAnswer }));
      expect(next).toBe(script.length);
      expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep))
        .toEqual(script.map(({ step }) => step));
      expect(fixture.invokeRaw).not.toHaveBeenCalled();
      const session = await fixture.application.services.sessions.getSessionById("session");
      expect(session?.messages.at(-1)).toMatchObject({ role: "assistant", content: finalAnswer });
      return events;
    },
  };
}
