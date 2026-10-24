import { expect, test } from "vitest";
import { AUTOMATION_BUILDER_PAYLOAD_FORMAT } from "../capabilities/automation-builder/payload-schema.js";
import { validateJsonSchemaValue } from "../model/json-schema-value.js";
import { modelReasoningPreferenceSchema } from "../../shared/model-reasoning-schema.js";
import { compileAutomationCreationRecipe } from "../capabilities/automation-builder/creation-recipe.js";
import { applyAutomationDraftBatch } from "../automations/draft-batch.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";

const recipe = (reasoningPreference: unknown) => ({ version: 1, steps: [{
  key: "answer", kind: "agent", title: "Answer", modelProfileId: "model", prompt: "Answer",
  reasoningPreference,
}] });

test.each([
  { profileId: "model", mode: "off" },
  { profileId: "model", mode: "server-default" },
  { profileId: "model", mode: "budget", budgetTokens: 512 },
  { profileId: "model", mode: "budget", budgetTokens: 0 },
])("authoring resolves the shared thinking schema for $mode", (preference) => {
  expect(validateJsonSchemaValue(AUTOMATION_BUILDER_PAYLOAD_FORMAT, recipe(preference))).toBeUndefined();
  expect(validateJsonSchemaValue(modelReasoningPreferenceSchema, preference)).toBeUndefined();
  const result = applyAutomationDraftBatch(createEmptyAutomationDefinition("test", "Thinking"), compileAutomationCreationRecipe(recipe(preference)), 1);
  expect(result.definition.body.children[0]).toMatchObject({ reasoningPreference: preference });
});

test.each([
  { profileId: "model", mode: "off", budgetTokens: 512 },
  { profileId: "model", mode: "budget" },
  { profileId: "model", mode: "budget", budgetTokens: -1 },
  { profileId: "model", mode: "budget", budgetTokens: 1.5 },
])("authoring rejects malformed thinking controls %#", (preference) => {
  expect(validateJsonSchemaValue(modelReasoningPreferenceSchema, preference)).toBeDefined();
  expect(() => applyAutomationDraftBatch(createEmptyAutomationDefinition("test", "Thinking"), compileAutomationCreationRecipe(recipe(preference)), 1)).toThrow();
});

test("an agent patch can explicitly clear reasoning without enlarging the generation format budget", () => {
  const plan = { version: 1, commands: [{ mutation: { kind: "update_node", nodeId: "agent",
    patch: { reasoningPreference: null } } }] };
  expect(validateJsonSchemaValue(AUTOMATION_BUILDER_PAYLOAD_FORMAT, plan)).toBeUndefined();
  expect(Buffer.byteLength(JSON.stringify(AUTOMATION_BUILDER_PAYLOAD_FORMAT))).toBeLessThanOrEqual(16 * 1024);
});
