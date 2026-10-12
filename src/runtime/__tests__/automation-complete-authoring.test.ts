import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import type { ChatMessage } from "../../model-gateway/types.js";
import { validateToolNormalInvocationInput, validateToolNormalInvocationPayload } from "../../capabilities/normal-invocation/validator.js";
import { compileAutomationGraph } from "../automations/graph-validation.js";
import { resolveAutomationBinding, type AutomationBindingContext } from "../automations/binding-resolution.js";
import type { ValueBinding } from "../automations/definition-contracts.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { AUTOMATION_AUTHORING_REFERENCE } from "../capabilities/automation-builder/authoring-reference.js";
import type { readAutomationAuthoringPreparation } from "../capabilities/automations/authoring-preparation.js";
import type { readAutomationAuthoringCatalogIndex } from "../capabilities/automations/authoring-catalog.js";
import { completeAuthoringPlan, createCompleteAuthoringFixture } from "./support/automation-complete-authoring-fixture.js";

type Fixture = Awaited<ReturnType<typeof createCompleteAuthoringFixture>>;
type Prepared = Awaited<ReturnType<typeof readAutomationAuthoringPreparation>>;
type Catalog = Awaited<ReturnType<typeof readAutomationAuthoringCatalogIndex>>;
type Receipt = { automationId: string; revision: number; aliases: Record<string, string> };
const fixtures: Fixture[] = [];
const prompt = "Build a draft for every morning: find existing article files to avoid duplication, research technology from the last two days with no more than three searches, then save one sourced opinion article in a new Markdown file. Leave activation to me and ask for the time later.";
const answer = "The complete connected draft is ready; choose the daily time and grant permissions before publishing it.";
const assignment = "Create the complete inventory, queries, search, article and save workflow as one connected draft, without activation.";
const wantedOperations = ["search_local_files", "search_many", "write_complete_file"];

function exactReceipt<T>(messages: readonly ChatMessage[], capabilityId: string): T {
  const message = [...messages].reverse().find((entry) => entry.role === "tool");
  expect(message).toBeDefined();
  const envelope = JSON.parse(message!.content);
  expect(envelope, JSON.stringify(envelope)).toMatchObject({ authority: "canonical_role_call_ledger",
    presenceEffect: "runtime_result_only_not_user_intent", result: { capabilityId,
      adapterResult: { kind: "registered_tool_execution_result_v1", result: { ok: true } } } });
  return JSON.parse(envelope.result.adapterResult.result.output) as T;
}

function boundValue(binding: ValueBinding, context: AutomationBindingContext) {
  const result = resolveAutomationBinding(binding, context);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

async function request(fixture: Fixture, text: string, requestId: string) {
  const events: Record<string, unknown>[] = [];
  await fixture.application.requests.handle({ send(value: string) {
    events.push(JSON.parse(value));
  } } as unknown as WebSocket, {
    type: "run_request", requestId, sessionId: "session", text,
    agentMode: "reasoning", modelPreference: { profileId: "scheduled-model", scope: "all" },
    toolPermissionMode: "full_access",
  });
  return events;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe("complete automation authoring through the ordinary request handler", () => {
  it("discovers, prepares, writes five connected steps once and validates without executing the workflow", async () => {
    const fixture = await createCompleteAuthoringFixture();
    fixtures.push(fixture);
    const phases: string[] = [];
    let activation = 0;
    let discovery: Catalog | undefined;
    let prepared: Prepared | undefined;
    let created: Receipt | undefined;
    let modelProfileId: string | undefined;
    fixture.invoke.mockImplementation(async (input) => {
      phases.push(String(input.modelStep));
      const messages = input.messages as readonly ChatMessage[];
      if (input.modelStep === "tool_payload.raw") {
        expect(input.format).toMatchObject({ type: "json_schema", name: "automation_draft_plan",
          strict: false, schema: { type: "object", additionalProperties: false } });
        expect(await fixture.service.list()).toEqual([]);
        expect(prepared).toBeDefined();
        const canonical = messages.find((message) => message.content.startsWith("Canonical runtime context:\n"));
        const context = JSON.parse(canonical!.content.slice("Canonical runtime context:\n".length));
        expect(context.acceptedCapability).toMatchObject({ capabilityId: "create_automation_draft",
          authoringObjective: assignment, controls: { title: "Daily technology editorial" } });
        expect(context.acceptedCapability).not.toHaveProperty("intent");
        const receipt = context.settledCapabilityResults.find((entry: { capabilityId: string }) => entry.capabilityId === "prepare_draft");
        expect(receipt).toMatchObject({ declaredEffect: "observation", outcome: "succeeded" });
        expect(JSON.parse(receipt.adapterResult.result.output)).toEqual(prepared);
        const source = messages.find((message) => message.content.startsWith('{"kind":"runtime_request_source_v1"'));
        expect(JSON.parse(source!.content)).toMatchObject({ authority: "reference_data", currentRequest: prompt });
        expect(messages.filter((message) => message.role === "user" && message.content === prompt)).toHaveLength(0);
        return { text: JSON.stringify(completeAuthoringPlan(modelProfileId!)), meta: {} };
      }
      expect(messages.filter((message) => message.role === "user" && message.content === prompt)).toHaveLength(1);
      if (input.modelStep === "execution.response") return { text: answer, meta: {} };
      expect(input.modelStep).toBe("execution.decision");
      activation += 1;
      if (activation === 1) return { text: JSON.stringify({ decision: {
        action: "open_capability_scope", catalogGroupIds: ["automations"],
        acknowledgement: "I will design and save the connected draft without running it.",
      } }), meta: {} };
      const catalogMessage = messages.find((message) => message.content.startsWith('{"kind":"runtime_execution_capability_catalog_v1"'));
      const capabilities = JSON.parse(catalogMessage!.content).capabilities as { capabilityId: string }[];
      expect(capabilities.map(({ capabilityId }) => capabilityId).sort()).toEqual([
        "add_saved_agent", "apply_automation_draft_changes", "browse_catalog", "create_automation_draft",
        "list_drafts", "prepare_draft", "read_draft", "save_agent", "validate_draft",
      ]);
      if (activation === 2) return { text: JSON.stringify({ decision: {
        action: "invoke_capability", capabilityId: "browse_catalog", intent: "Discover the available workflow tools and models.",
        selectionControls: { offset: 0 }, workingDirectory: ".",
      } }), meta: {} };
      if (activation === 3) {
        discovery = exactReceipt<Catalog>(messages, "browse_catalog");
        expect(discovery.catalogScope).toEqual({ kind: "pre_draft" });
        expect(discovery.permissions).toEqual(AUTOMATION_AUTHORING_REFERENCE.permissions);
        expect(await fixture.service.list()).toEqual([]);
        expect(discovery.nextOffset).toBeNull();
        const chosen = discovery.operations.items.filter((operation) => wantedOperations.includes(operation.operationId));
        expect(chosen).toHaveLength(3);
        modelProfileId = discovery.models.items[0]!.id;
        return { text: JSON.stringify({ decision: {
          action: "invoke_capability", capabilityId: "prepare_draft", intent: "Read the selected contracts and complete authoring reference.",
          selectionControls: { operationRefs: chosen.map(({ ref }) => ref) },
        } }), meta: {} };
      }
      if (activation === 4) {
        prepared = exactReceipt<Prepared>(messages, "prepare_draft");
        expect(prepared).toMatchObject({ kind: "automation_authoring_preparation_v1", authority: "runtime_registry",
          catalogScope: { kind: "pre_draft" },
          presenceEffect: "authoring_reference_not_user_intent_or_execution", grantsPermissions: false, executesWorkflow: false });
        expect(prepared.authoringReference).toEqual(JSON.parse(JSON.stringify(AUTOMATION_AUTHORING_REFERENCE)));
        expect(prepared.operations.map(({ operationId }) => operationId).sort()).toEqual([...wantedOperations].sort());
        const available = await fixture.service.catalog("");
        for (const operation of prepared.operations) {
          const exact = available.grantableOperations.find((candidate) => candidate.toolName === operation.toolName && candidate.operationId === operation.operationId)!;
          expect(operation.input).toEqual(exact.input);
          expect(operation.payload).toEqual(exact.payload);
          expect(operation.granted).toBe(false);
        }
        expect(await fixture.service.list()).toEqual([]);
        return { text: JSON.stringify({ decision: {
          action: "invoke_capability", capabilityId: "create_automation_draft", intent: "Save the complete connected draft.",
          operationObjective: assignment,
          selectionControls: { title: "Daily technology editorial" },
        } }), meta: {} };
      }
      if (activation === 5) {
        created = exactReceipt<Receipt>(messages, "create_automation_draft");
        expect(created.revision).toBe(1);
        expect(Object.keys(created.aliases).sort()).toEqual(["article", "inventory", "queries", "root", "save", "search"]);
        return { text: JSON.stringify({ decision: {
          action: "invoke_capability", capabilityId: "validate_draft", intent: "Check the saved draft before handing it back.",
          selectionControls: { automationId: created.automationId },
        } }), meta: {} };
      }
      expect(activation).toBe(6);
      expect(exactReceipt(messages, "validate_draft")).toEqual({ issues: [] });
      return { text: JSON.stringify({ decision: { action: "respond" } }), meta: {} };
    });

    const events = await request(fixture, prompt, "complete-automation-authoring");
    expect(events.at(-1), JSON.stringify(events.at(-1))).not.toMatchObject({ type: "failed" });
    expect(created, JSON.stringify({ phases, terminal: events.at(-1) })).toBeDefined();
    expect(phases).toEqual(["execution.decision", "execution.decision", "execution.decision", "execution.decision",
      "tool_payload.raw", "execution.decision", "execution.decision", "execution.response"]);
    expect(fixture.execute.mock.calls.map(([call]) => call.params.action)).toEqual([
      "browse_catalog", "prepare_draft", "create_automation_draft", "validate_draft",
    ]);
    expect(await fixture.service.list()).toHaveLength(1);
    const draft = (await fixture.service.getDraft(created!.automationId))!;
    expect(draft.revision).toBe(1);
    expect(draft.definition.trigger).toEqual({ kind: "manual" });
    expect(draft.definition).not.toHaveProperty("workingDirectory");
    const compiled = compileAutomationGraph(draft.definition);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
    const [inventory, queries, search, article, save] = compiled.graph.steps.map(({ node }) => node);
    if (inventory!.kind !== "tool" || queries!.kind !== "agent" || search!.kind !== "tool" || article!.kind !== "agent" || save!.kind !== "tool")
      throw new Error("unexpected_authored_step_kinds");
    expect(compiled.graph.steps.map(({ dependsOn }) => dependsOn)).toEqual([
      [], [inventory.id], [queries.id], [search.id], [article.id],
    ]);
    expect(queries.modelProfileId).toBe(modelProfileId);
    expect(article.modelProfileId).toBe(modelProfileId);
    expect(queries.tools).toEqual([]);
    expect(article.tools).toEqual([]);
    expect(article.acceptance).toEqual([{ field: "ready", equals: true }]);
    if (queries.result.kind !== "json" || article.result.kind !== "json") throw new Error("structured_results_required");
    const plannedQueries = ["Technology today", "Computing yesterday", "Energy innovation yesterday"];
    const writtenArticle = { title: "One evidence-based opinion", path: "articles/one-evidence-based-opinion.md",
      summary: "What changed and why it matters.", bodyMarkdown: "Evidence-backed article with source links.", ready: true };
    expect(validateJsonSchemaValue(queries.result.schema, { queries: plannedQueries })).toBeUndefined();
    expect(validateJsonSchemaValue(queries.result.schema, { queries: [...plannedQueries, "Excess search"] })).toBeDefined();
    expect(validateJsonSchemaValue(article.result.schema, writtenArticle)).toBeUndefined();
    const existingInventory = { items: [{ path: "articles/previously-covered-topic.md" }], itemCount: 1 };
    const evidence: AutomationBindingContext = { runInputs: {}, sourceFiles: [], branchResults: new Map(), nodeResults: new Map([
      [inventory.id, { status: "succeeded", text: "Inventory: 1 entry", data: existingInventory }],
      [queries.id, { status: "succeeded", data: { queries: plannedQueries } }],
      [search.id, { status: "succeeded", text: "Observed recent technology sources" }],
      [article.id, { status: "succeeded", data: writtenArticle }],
    ]) };
    expect(boundValue(queries.inputs.inventory!, evidence)).toEqual(existingInventory);
    expect(boundValue(article.inputs.inventory!, evidence)).toEqual(existingInventory);
    expect(boundValue(article.inputs.research!, evidence)).toBe("Observed recent technology sources");
    const controls = (node: typeof inventory | typeof search | typeof save) => Object.fromEntries(Object.entries(node.controls)
      .map(([key, binding]) => [key, boundValue(binding, evidence)]));
    expect(controls(inventory)).toEqual({ query: ".md", mode: "names", case_sensitive: false });
    expect(controls(search)).toEqual({ queries: plannedQueries });
    expect(controls(save)).toEqual({ path: writtenArticle.path });
    expect(boundValue(save.payload!, evidence)).toBe(writtenArticle.bodyMarkdown);
    for (const node of [inventory, search, save]) {
      const operation = prepared!.operations.find((candidate) => candidate.toolName === node.operation.toolName && candidate.operationId === node.operation.operationId)!;
      const contract = { ...operation, summary: operation.label };
      expect(validateToolNormalInvocationInput(contract, controls(node))).toMatchObject({ ok: true });
      if (node.payload) expect(validateToolNormalInvocationPayload(contract, boundValue(node.payload, evidence))).toBeUndefined();
    }
    expect(fixture.executeFutureTool).not.toHaveBeenCalled();
    expect(await fixture.service.getGrant(created!.automationId)).toBeNull();
    expect(await fixture.scheduler.getAutomationJob(created!.automationId)).toBeNull();
    expect(await fixture.service.listRuns(created!.automationId)).toEqual([]);
    expect(fixture.invokeRaw).not.toHaveBeenCalled();
    const session = await fixture.application.services.sessions.getSessionById("session");
    expect(session?.messages.at(-1)).toMatchObject({ role: "assistant", content: answer });
  });

  it("leaves an unrelated ordinary response free of authoring evidence or mutations", async () => {
    const fixture = await createCompleteAuthoringFixture();
    fixtures.push(fixture);
    await request(fixture, "Say hello.", "unrelated-authoring-negative-control");
    expect(fixture.invoke.mock.calls.map(([input]) => input.modelStep)).toEqual(["execution.decision", "execution.response"]);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.executeFutureTool).not.toHaveBeenCalled();
    expect(await fixture.service.list()).toEqual([]);
    for (const [input] of fixture.invoke.mock.calls) {
      const evidence = (input.messages as readonly ChatMessage[]).filter((message) => message.role === "tool");
      expect(evidence).toEqual([]);
    }
  });
});
