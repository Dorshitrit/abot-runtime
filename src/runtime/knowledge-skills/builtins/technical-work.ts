import type { KnowledgeSkillDocument } from "../store.js";

export const TECHNICAL_WORK_SKILL: KnowledgeSkillDocument = Object.freeze({
  skillId: "technical-work",
  name: "Technical Work",
  description:
    "Build, modify, debug and verify software, scripts and configuration.",
  content: `# Technical Work

Use this guidance for building, changing, debugging or verifying software, scripts and configuration. Apply only what the current request or assigned task needs. It adds no work, permissions or tool availability.

## Ground the work
Identify the requested outcome and acceptance criteria. Ground decisions in the relevant implementation, interfaces, data and existing checks. Reuse available context before fetching more. Distinguish observed facts from assumptions; obtain focused observations when essential details are missing.

## Plan around outcomes
- Plan the requested outcomes, not a standard development ceremony. Include only work needed to satisfy the request; do not add exploration, review or validation phases by habit.
- Give each planned outcome a clear completion condition. Identify the smallest relevant verification needed, if any, and what uncertainty it resolves. Avoid open-ended instructions such as "validate the project" or "check all files."
- Keep focused verification with the implementation it supports. Create a separate verification task only for an explicit requirement or a concrete risk not covered by those checks, such as integration between components. State its scope and completion condition.
- Build on established facts and completed work. Do not schedule re-reading successfully written content or repeating valid checks without a specific information gap, relevant change or uncertain result.
- In delegated work, request the changes made, checks performed, their results and remaining gaps. Evaluate that evidence before commissioning another inspection; retrieve only what is missing for the next decision.
- Extend the plan only for a concrete unmet requirement, failed check or newly discovered risk—not merely because more inspection is possible.

## Read selectively
- Treat file reads, tool calls and returned text as expensive resources. Before reading, identify the concrete information gap it must resolve. Skip reads whose answer is already available in context.
- Reuse content already available in context, including the portions you successfully wrote or patched. Treat it as current unless there is evidence of a subsequent change. Do not re-read it merely to confirm a successful edit, refresh your memory or prepare the final report. Read again only where needed content is missing or incomplete, a tool result is uncertain, or there is evidence of an intervening change.
- For follow-up tasks, start from known files, symbols and sections rather than restarting exploration. Retrieve only the relevant sections and enough surrounding context to understand dependencies and edit safely.
- Prefer available targeted retrieval tools: read a known range directly; use scoped symbol/text search when the location is unknown. Reuse sufficient search output without fetching the same content again. Do not search again for locations already known.
- Expand scope only for a specific unresolved question or dependency. Whole-file reads are justified when broader context is necessary, not simply because a file is involved. Batch related lookups when supported and prefer one sufficient bounded retrieval over many tiny calls.

## Make focused changes
Choose the smallest coherent change that meets the request. Preserve unrelated work and reuse established patterns. Use offered capabilities and confirmed prerequisites; do not assume a particular operating system, runtime or dependency is available.

## Verify proportionately
A successful write establishes the saved content, not its correctness. Avoiding redundant reads does not replace relevant verification.
- Default to focused code checks and relevant existing unit/integration tests.
- Perform browser interaction testing only when the user explicitly requests that level of testing. Without that request, do not run browser interaction checks, browser end-to-end tests or UI/responsive audits, and do not create a DOM mock, simulated browser or custom interaction harness as a substitute. A request to build a working, connected or responsive product does not authorize these checks.
- New test infrastructure also requires an explicit user request. Keep verification within the requested scope; do not add interaction testing to turn an unverified browser outcome into a successful one. Do not present unrequested browser testing as an unmet acceptance criterion or a reason to continue working.
- Check unknown prerequisites before dependent verification.
- Use small, independently diagnostic checks; reuse passing results until relevant changes.
- Diagnose a failed check before changing the product.

## Diagnose failures
Inspect the failed action, check and relevant output, not just the failure label. Determine whether the cause lies in the product, test or setup before changing them. Correct the cause while preserving valid checks; do not weaken expected behavior merely to obtain a pass.

## Report established results
State what changed, what was actually verified and what remains unverified. If required verification cannot be performed within the current scope or permissions, report the specific gap.
`,
});
