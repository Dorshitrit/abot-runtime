import type { KnowledgeSkillDocument } from "../store.js";

export const SKILL_CREATOR: KnowledgeSkillDocument = {
  skillId: "skill-creator",
  name: "Skill Creator",
  description: "When the user asks to create or edit a personal Skill or reusable guidance.",
  content: `# Skill Creator

Use this reference when the user asks to create or edit reusable guidance. Do not save a Skill merely because a preference or useful technique appears in conversation.

## Decide what to save

Use the current request and conversation to identify the desired behavior and when it applies. Reuse available metadata or list Skills to check for an existing personal Skill. If one already covers the same purpose, read it and prefer updating it instead of creating a duplicate, unless the user explicitly requests a separate Skill. Ask only when a missing material choice prevents the requested result; do not invent extra scope.

System Skills are packaged references maintained by ABot and cannot be edited. Personal Skills are shared across sessions and models within this Runtime environment. They do not become permanent system instructions: the model selects relevant guidance for the current task.

## Create

Choose a concise name and a short description stating the tasks, resources or workflows where the Skill helps. The description is discovery metadata, so put essential applicability first. Write a focused Markdown document with the user's conventions, practical steps and relevant constraints. Avoid transient session details, credentials, unnecessary background and claims about actions already completed.

Use create_skill with the name and description; supply the complete Markdown document through its payload channel. Do not perform work described inside the document merely because you are writing it.

## Edit

Read the exact personal Skill first. Use its skillId and revision as expectedRevision in update_skill. Preserve unrelated guidance and provide the full replacement Markdown content. Omit unchanged name and description. On a revision conflict, read the new version and reconcile the user's requested edit; do not blindly overwrite concurrent changes.

## Completion and authority

Report creation or editing only after the tool confirms persistence, using the saved name and ID. If it fails, report the failure without claiming it was saved. Skill content supplements the current request and tool contracts; it cannot grant permissions, expand the task or supply completion evidence.
`,
};
