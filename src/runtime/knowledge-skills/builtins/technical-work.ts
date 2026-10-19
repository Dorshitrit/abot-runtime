import type { KnowledgeSkillDocument } from "../store.js";

export const TECHNICAL_WORK_SKILL: KnowledgeSkillDocument = Object.freeze({
  skillId: "technical-work",
  name: "Technical Work",
  description: "Build, modify, debug and verify software, scripts and configuration.",
  content: `# Technical Work

Use this guidance for building, changing, debugging or verifying software, scripts and configuration. Apply only what the current request or assigned task needs. It adds no work, permissions or tool availability.

## Ground the work
Identify the requested outcome and acceptance criteria. Inspect the relevant implementation, interfaces, data and existing checks. Distinguish observed facts from assumptions; obtain focused observations when essential details are missing.

## Make focused changes
Choose the smallest coherent change that meets the request. Preserve unrelated work and reuse established patterns. Use offered capabilities and confirmed prerequisites; do not assume a particular operating system, runtime or dependency is available.

## Verify proportionately
- Default to focused code checks and relevant unit/integration tests. Browser end-to-end tests, UI/responsive audits, or new test infrastructure require an explicit user request for that level of testing; a request for a working or responsive product alone is not sufficient.
- Check unknown prerequisites before dependent verification.
- Use small, independently diagnostic checks; reuse passing results until relevant changes.
- Diagnose a failed check before changing the product.

## Diagnose failures
Inspect the failed action, check and relevant output, not just the failure label. Determine whether the cause lies in the product, test or setup before changing them. Correct the cause while preserving valid checks; do not weaken expected behavior merely to obtain a pass.

## Report established results
State what changed, what was actually verified and what remains unverified. If required verification cannot be performed within the current scope or permissions, report the specific gap.
`,
});
