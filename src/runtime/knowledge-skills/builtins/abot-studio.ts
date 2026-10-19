import type { KnowledgeSkillDocument } from "../store.js";

export const ABOT_STUDIO_SKILL: KnowledgeSkillDocument = Object.freeze({
  skillId: "abot-studio",
  name: "ABot Studio",
  description: "Building and explaining ABot Studio automations: design, drafts, and checks.",
  content: `# ABot Studio

Use this reference when the current task concerns an automation draft or a reusable agent in ABot Studio. It is procedural documentation, subordinate to the user's request and your assigned objective. It grants no permission to publish, activate or run an automation. Read the offered tool schemas and operation guidance for current parameters.

## Establish the requested outcome
Identify the input, desired output, trigger if requested, destination and success criteria. Separate creating a draft from running its future workflow. Resolve a missing material requirement before implementing dependent work; keep choices already made by the user. Inspect the existing draft when editing one, and retain its exact identity and revision.

## Design a connected workflow
Express each step as one useful outcome. Use a tool step for a concrete operation and an agent step for work requiring model judgment. Connect outputs explicitly to their consumers instead of assuming that later steps share an earlier step's context. Decide whether each edge carries text, structured data, a file reference or another supported result. Use parallel branches only for independent work, then supply the required results to the joining step.

For each agent, specify a bounded objective, the input it actually needs and the shape of its output. Make structured fields explicit when later steps depend on them. Preserve the user's selected model and tools. Reuse a saved agent when its existing contract fits, checking the exact available revision and bindings.

## Discover and author
Use the Studio catalog to discover available workflow operations. The catalog describes what a future workflow can use; discovery does not execute those operations. Fetch the exact needed schemas and the current authoring reference through prepare_draft. That reference owns the current grammar, limits, settings and binding syntax.

Use automation_builder to create a connected draft or apply a connected change. Its returned draft identity, revision and step references are the source for later edits. For edits, use the inspected current revision and preserve unrelated steps. A rejected change is not a saved change: inspect the reported issue before proposing another edit. Do not invent node identities or replace the whole draft to conceal an unknown current state.

## Check the result
Read and validate the saved draft as needed. Check that the requested outputs exist in the definition, references resolve to the intended producer, joins receive their inputs and paths have the intended per-run or shared lifetime. Distinguish graph validity from actual behavior: a valid draft has not thereby executed successfully.

Report what was saved, its identity and revision, what was checked, and any unresolved requirement. Publication, activation and execution remain separate actions governed by the current user request and the tools' existing permission checks.
`,
});
