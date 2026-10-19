import { expect, test } from "vitest";
import {
  AVAILABLE_SKILLS_DESCRIPTION_MAX_LENGTH,
  AVAILABLE_SKILLS_MAX_TOKENS,
  buildAvailableSkillsText,
  projectAvailableSkillsInstructions,
} from "../knowledge-skills/available-skills-projection.js";
import { assessRequestMessagesBudget } from "../context/request-context-budget.js";
import { projectRequestContext } from "../context/request-context.js";
import { estimateMessageTokens } from "../context/token-estimator.js";
import { builtinKnowledgeSkillStore } from "../knowledge-skills/catalog.js";

const skill = { skillId: "read-guide", name: "Reading guide", description: "Use for reading." };
const context = {
  instructions: "Follow the current request.",
  prompt: "Hello.",
  historyMessages: [],
  budget: {
    contextWindowTokens: 32000,
    outputReserveTokens: 1000,
    safetyReserveTokens: 200,
    attachmentReserveTokens: 100,
  },
};

test("renders names, exact IDs and brief descriptions as plain pipe-separated text", () => {
  const text = buildAvailableSkillsText({
    skills: [skill, { ...skill, skillId: "other", name: "Other guide", description: "Other guidance." }],
    budgetTokens: AVAILABLE_SKILLS_MAX_TOKENS,
  })!;
  expect(text).toContain("Reading guide [read-guide]: Use for reading. | Other guide [other]: Other guidance.");
  expect(text).not.toContain('"skillId"');
});

test("builtin names and complete descriptions fit discovery without shortening", () => {
  const skills = builtinKnowledgeSkillStore.list();
  const text = buildAvailableSkillsText({ skills, budgetTokens: AVAILABLE_SKILLS_MAX_TOKENS })!;
  for (const entry of skills) {
    expect(entry.description.length).toBeLessThanOrEqual(AVAILABLE_SKILLS_DESCRIPTION_MAX_LENGTH);
    expect(text).toContain(entry.name + " [" + entry.skillId + "]: " + entry.description);
  }
  expect(text).not.toContain("…");
  expect(text).not.toContain("Partial catalog");
  expect(estimateMessageTokens({ role: "system", content: text }))
    .toBeLessThanOrEqual(AVAILABLE_SKILLS_MAX_TOKENS);
});

test("bounds a large catalog and marks omitted entries without modifying source documents", () => {
  const skills = Array.from({ length: 1000 }, (_, index) => ({
    ...skill, skillId: "skill-" + index,
    name: "NAME".repeat(10000), description: "D".repeat(10000),
  }));
  const original = structuredClone(skills);
  const text = buildAvailableSkillsText({ skills, budgetTokens: AVAILABLE_SKILLS_MAX_TOKENS })!;
  expect(estimateMessageTokens({ role: "system", content: text }))
    .toBeLessThanOrEqual(AVAILABLE_SKILLS_MAX_TOKENS);
  expect(text).toContain("Partial catalog");
  expect(text).toContain("list_skills");
  expect(text).toContain("[skill-0]:");
  expect(text).not.toContain("[skill-999]:");
  expect(text).not.toContain("NAME".repeat(20));
  expect(text).not.toContain("D".repeat(80));
  expect(skills).toEqual(original);
});

test("can omit the LIST affordance for a bounded catalog without changing default discovery", () => {
  const skills = Array.from({ length: 100 }, (_, index) => ({ ...skill, skillId: `guide-${index}` }));
  const options = { skills, budgetTokens: AVAILABLE_SKILLS_MAX_TOKENS };
  const standard = buildAvailableSkillsText(options)!;
  const withoutList = buildAvailableSkillsText({ ...options, includeListHint: false })!;
  expect(standard).toContain("list_skills");
  expect(standard).toBe(buildAvailableSkillsText({ ...options, includeListHint: true }));
  expect(withoutList).not.toContain("list_skills");
  expect(withoutList).toContain("[guide-0]:");
  expect(withoutList).not.toContain("[guide-99]:");
  expect(estimateMessageTokens({ role: "system", content: withoutList }))
    .toBeLessThanOrEqual(AVAILABLE_SKILLS_MAX_TOKENS);
});

test("encodes IDs reversibly and separates their delimiters from names and descriptions", () => {
  const skillId = "pipe|line\ncolon:שלום";
  const text = buildAvailableSkillsText({
    skills: [{ ...skill, skillId, name: "Reading\n guide | name [fake]: decoy", description: "First\nline | second [other]: decoy" }],
    budgetTokens: AVAILABLE_SKILLS_MAX_TOKENS,
  })!;
  const entry = text.split("\n")[1]!;
  const encoded = entry.slice(entry.lastIndexOf(" [") + 2, entry.lastIndexOf("]: "));
  expect(decodeURIComponent(encoded)).toBe(skillId);
  expect(entry).toBe("Reading guide name (fake): decoy [" + encoded + "]: First line second (other): decoy");
  expect(entry.match(/\[[^\]]*\]:/gu)).toEqual(["[" + encoded + "]:"]);
});

test("does not truncate an oversized ID into a different readable identity", () => {
  const text = buildAvailableSkillsText({
    skills: [{ ...skill, skillId: "X".repeat(129) }, skill],
    budgetTokens: AVAILABLE_SKILLS_MAX_TOKENS,
  })!;
  expect(text).not.toContain("X");
  expect(text).toContain("Partial catalog");
  expect(text).toContain("[read-guide]:");
});

test("counts discovery in existing instructions without changing message topology or intent", () => {
  const instructions = projectAvailableSkillsInstructions({ skills: [skill], context });
  const discovery = buildAvailableSkillsText({ skills: [skill], budgetTokens: AVAILABLE_SKILLS_MAX_TOKENS });
  expect(instructions).toBe(discovery + "\n" + context.instructions);
  const baseline = projectRequestContext(context);
  const projected = projectRequestContext({ ...context, instructions });
  expect(projected.messages.map(({ role }) => role)).toEqual(baseline.messages.map(({ role }) => role));
  expect(projected.messages.filter(({ role }) => role === "user"))
    .toEqual(baseline.messages.filter(({ role }) => role === "user"));
  expect(projected.budget.estimatedInputTokens).toBeGreaterThan(baseline.budget.estimatedInputTokens);
  expect(projectAvailableSkillsInstructions({ skills: [], context })).toBe(context.instructions);
});

test("keeps bounded discovery above the compaction threshold and accounts for it", () => {
  const constrained = {
    ...context,
    instructions: "I".repeat(2900),
    budget: { ...context.budget, contextWindowTokens: 2000, outputReserveTokens: 200, safetyReserveTokens: 100 },
  };
  const instructions = projectAvailableSkillsInstructions({ skills: [skill], context: constrained });
  const projected = projectRequestContext({ ...constrained, instructions });
  expect(instructions).toContain("[read-guide]:");
  expect(projected.budget.estimatedInputTokens).toBeGreaterThan(projected.budget.compactionTriggerInputTokens);
  expect(projected.budget.estimatedInputTokens).toBeLessThan(projected.budget.availableInputTokens);
  expect(projected.budget.parts.instructionInputTokens)
    .toBe(estimateMessageTokens({ role: "system", content: instructions }));
});

test("ordinary compaction reduces eligible evidence while retaining the bounded catalog", () => {
  const constrained = {
    ...context,
    referenceParts: [{
      sourceRef: "large-result", category: "request_reference" as const, retention: "compactable" as const,
      messages: [{ role: "user" as const, content: "R".repeat(3000) }],
      compactMessages: [{ role: "user" as const, content: "A compact result." }],
    }],
    budget: { ...context.budget, contextWindowTokens: 2000, outputReserveTokens: 200, safetyReserveTokens: 100 },
  };
  const instructions = projectAvailableSkillsInstructions({ skills: [skill], context: constrained });
  const projected = projectRequestContext({ ...constrained, instructions });
  expect(projected.compaction.compactedSourceRefs).toEqual(["large-result"]);
  expect(projected.messages[0]!.content).toContain("[read-guide]:");
  expect(projected.messages).toContainEqual({ role: "user", content: "A compact result." });
  expect(projected.messages.filter(({ content }) => content === context.prompt)).toHaveLength(1);
});

test.each([
  { outputReserveTokens: 1900 },
  { configuredInstructionReserveTokens: 1500 },
])("ordinary admission still rejects required content over its budget: %j", (reserve) => {
  const constrained = {
    ...context,
    budget: { ...context.budget, contextWindowTokens: 2000, ...reserve },
  };
  const instructions = projectAvailableSkillsInstructions({ skills: [skill], context: constrained });
  expect(instructions).toContain("[read-guide]:");
  expect(() => projectRequestContext({ ...constrained, instructions })).toThrow(/exceeds_budget/);
});

test("final admission counts steering alongside discovery instead of discarding the catalog", () => {
  const constrained = { ...context, budget: { ...context.budget, contextWindowTokens: 2000 } };
  const instructions = projectAvailableSkillsInstructions({ skills: [skill], context: constrained });
  const projected = projectRequestContext({ ...constrained, instructions });
  const messages = [...projected.messages, { role: "user" as const, content: "steering ".repeat(3000) }];
  expect(messages[0]!.content).toContain("[read-guide]:");
  expect(assessRequestMessagesBudget({ messages, budget: constrained.budget }).fits).toBe(false);
  expect(buildAvailableSkillsText({ skills: [skill], budgetTokens: 1 })).toBeUndefined();
});
