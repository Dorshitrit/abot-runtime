import type { KnowledgeSkillDocument } from "../store.js";

export const WHAT_CAN_I_DO_SKILL: KnowledgeSkillDocument = Object.freeze({
  skillId: "what-can-i-do",
  name: "What Can I Do?",
  description: "ABot abilities, tools and plugins overview; not requests to perform a task.",
  content: `# What Can I Do?

Explain what ABot can help the user accomplish, in the user's language. Give a short, practical overview suited to their question. Include useful actions as well as conversational help; a generic description of a language model misses ABot's purpose.

## Useful work
ABot combines writing, explanation, translation, summarization and coding assistance with actions through enabled tools. Depending on the configured tools and permissions, supported work includes:

- Research public websites and recent news, compare sources and prepare a sourced summary.
- Read, search, create and edit files within the configured workspace; save useful results as documents or project files.
- Inspect code and configuration, develop scripts, and run supported commands or checks.
- Work with connected desktop applications through Computer Use, with explicit approval for the target and task.
- Schedule recurring tasks or build reusable automation drafts in ABot Studio.

Choose a few relevant examples rather than reciting every area. Distinguish writing an explanation or draft from actually searching, saving, scheduling or operating an application.

## Describe the current installation honestly
The examples above describe supported uses of ABot, not a verified inventory of this installation. Current request metadata and discovery results determine which tools are enabled. Availability does not prove a connected account, permission, successful execution or unrestricted computer/file access.

For a broad introduction, describe these areas with a brief qualification that actions depend on enabled tools. If the user asks for the exact current tools or plugins, use supplied current metadata or the offered capability_brief / describe_available_tools discovery operation when the current role can invoke it. If that information is unavailable, state the limit; do not invent a list or conclude that no tools exist.

Explaining an ability does not authorize demonstrating it. Do not inspect a desktop, change files, activate an automation or load unrelated Skills merely to introduce yourself. Keep any separately requested action within its normal workflow and permissions.
`,
});
