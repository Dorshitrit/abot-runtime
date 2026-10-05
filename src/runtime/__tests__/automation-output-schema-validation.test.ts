import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, test } from "vitest";
import { AutomationRoutes } from "../../web-ui/local-runtime/automation-routes.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { parseAutomationDefinition } from "../automations/definition-input.js";
import { validateAutomationGraph } from "../automations/graph-validation.js";
import { createSchedulerRuntimeFixture } from "./support/scheduler-runtime-fixture.js";

const fixtures: Awaited<ReturnType<typeof createSchedulerRuntimeFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

const boundedArray = { type: "array", minItems: 0, maxItems: 3 };
const validArray = { ...boundedArray, items: { type: "string", minLength: 0, maxLength: 80 } };
function result(property: unknown) {
  return { kind: "json", schema: { type: "object", additionalProperties: false,
    properties: { values: property }, required: ["values"] } };
}
function agent(property: unknown) {
  return { kind: "agent", title: "Extract", onFailure: "stop", modelProfileId: "scheduled-model",
    agentMode: "fast", roleInstructions: "", prompt: "Extract", inputs: {}, tools: [],
    result: result(property) };
}

test.each([
  ["missing", boundedArray],
  ["undefined", { ...boundedArray, items: undefined }],
  ["null", { ...boundedArray, items: null }],
  ["string", { ...boundedArray, items: "string" }],
  ["number", { ...boundedArray, items: 1 }],
  ["boolean", { ...boundedArray, items: false }],
])("%s array items produce an editable draft with an actionable validation issue", async (_name, property) => {
  const runtime = await createSchedulerRuntimeFixture();
  fixtures.push(runtime);
  const studio = runtime.application.services.automations!;
  const created = await studio.create("Invalid result schema");
  // Draft authoring intentionally retains incomplete schemas so the user can repair them.
  const draft = await studio.updateDraft(created.automationId, created.revision, {
    kind: "add_node", parentSequenceId: created.definition.body.id, index: 0,
    nodeWithoutId: agent(property),
  });
  const schemaIssue = expect.objectContaining({ code: "automation_output_schema_invalid",
    path: "body.children.0.result.schema", message: expect.stringContaining("items") });
  expect(await studio.validate(draft.automationId)).toEqual([schemaIssue]);

  let status = 0;
  let body: Record<string, unknown> = {};
  const response = { writeHead(code: number) { status = code; },
    end(value: string) { body = JSON.parse(value); }, setHeader() {},
  } as unknown as ServerResponse;
  const routes = new AutomationRoutes(() => ({ start: async () => {}, services: { automations: studio } }));
  await routes.handle({ method: "GET", segments: ["automations", draft.automationId, "draft"],
    url: new URL(`http://localhost/automations/${draft.automationId}/draft`), body: null,
    environmentId: runtime.config.runtimeId, request: {} as IncomingMessage, response });
  expect(status).toBe(200);
  expect(body).toMatchObject({ ok: true, draft: JSON.parse(JSON.stringify(draft)), validation: [schemaIssue] });

  const repaired = await studio.updateDraft(draft.automationId, draft.revision, {
    kind: "update_node", nodeId: draft.definition.body.children[0]!.id,
    patch: { result: result(validArray) },
  });
  expect(await studio.validate(repaired.automationId)).toEqual([]);
  expect(await studio.getDraft(repaired.automationId)).toEqual(repaired);
  expect(runtime.invoke).not.toHaveBeenCalled();
  expect(runtime.invokeRaw).not.toHaveBeenCalled();
  expect(await runtime.scheduler.getAutomationJob(draft.automationId)).toBeNull();
});

test("an invalid schema does not suppress other steps' bindings, output bounds or acceptance checks", () => {
  const empty = createEmptyAutomationDefinition("automation", "Independent validation");
  const definition = parseAutomationDefinition({ ...empty, body: { ...empty.body, children: [
    { ...agent({ ...boundedArray, items: null }), id: "invalid-output" },
    { ...agent({ type: "string", minLength: 0 }), id: "other-step",
      inputs: { missing: { kind: "node_result", nodeId: "not-before-this-step", select: "text" } },
      acceptance: [{ field: "undeclared", equals: true }] },
  ] } });
  expect(validateAutomationGraph(definition)).toEqual([
    expect.objectContaining({ code: "automation_output_schema_invalid", path: "body.children.0.result.schema" }),
    expect.objectContaining({ code: "automation_dependency_missing", path: "body.children.1.inputs.missing" }),
    expect.objectContaining({ code: "automation_output_schema_invalid", path: "body.children.1.result.schema.values" }),
    expect.objectContaining({ code: "automation_acceptance_invalid", path: "body.children.1.acceptance.0" }),
  ]);
});

test("valid bounded array output and scalar acceptance still allow a later data binding", () => {
  const empty = createEmptyAutomationDefinition("automation", "Valid outputs");
  const producer = agent(validArray);
  const definition = parseAutomationDefinition({ ...empty, body: { ...empty.body, children: [
    { ...producer, id: "producer", result: { kind: "json", schema: {
      ...producer.result.schema, properties: { values: validArray, ready: { type: "boolean" } },
      required: ["values", "ready"],
    } }, acceptance: [{ field: "ready", equals: true }] },
    { ...agent(validArray), id: "consumer",
      inputs: { source: { kind: "node_result", nodeId: "producer", select: "data", pointer: "/values" } } },
  ] } });
  expect(validateAutomationGraph(definition)).toEqual([]);
});


test.each([
  ["scalar", false, 4_096, true],
  ["scalar", false, 4_097, false],
  ["array item", true, 4_096, true],
  ["array item", true, 4_097, false],
] as const)("preserves automation output bound: %s array=%s max=%i accepted=%s", (_label, array, maxLength, accepted) => {
  const scalar = { type: "string", minLength: 0, maxLength };
  const property = array ? { ...boundedArray, items: scalar } : scalar;
  const empty = createEmptyAutomationDefinition("automation", "Result boundary");
  const definition = parseAutomationDefinition({ ...empty, body: { ...empty.body,
    children: [{ ...agent(property), id: "producer" }],
  } });
  const issues = validateAutomationGraph(definition);
  expect(issues).toEqual(accepted ? [] : [expect.objectContaining({
    code: "automation_output_schema_invalid", path: "body.children.0.result.schema.values",
  })]);
});
