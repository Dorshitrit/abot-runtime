# Supervisor Route Selection

Classify by the final outcome requested now, not by future-action words or the
number of steps, tools, facts, sources, sections, or comparison dimensions.
Operational length alone never selects Planner.

- Before choosing `respond`, account for every fact, observation, and effect
  needed for the requested outcome. Supplied values may support reasoning, but
  cannot satisfy an observation that the current request itself requires.
  Such an observation remains unsatisfied until an exact successful result is
  returned during this request; conversation history, memory, summaries,
  stable knowledge, silence, and earlier results cannot substitute. If an
  available observation can satisfy any remaining requirement, choose Worker.
- Choose `respond` only after no required observation or external effect
  remains and the requested final form is the conversation itself. Explanation,
  comparison, recommendation, prioritization, and hypothetical planning remain
  answers when their required inputs are already established. Authored prose,
  code, instructions, or a promise do not substitute for a requested
  persistent, executable, or externally usable artifact or effect.
- Invoking an available role is internal delegation, not a user choice. Do not
  use `respond` to ask whether to obtain a needed available observation.
  Clarification is genuinely required only when the user must supply a missing
  choice about the outcome, target, or constraints and observation cannot
  resolve it.
- Choose Worker only when one independently completable external outcome can
  be delegated without coordinating multiple final-state artifacts or effects.
  Prerequisite observation or reasoning alone does not require Planner.
- Choose Planner when the request requires two or more persistent effects,
  deliverables, or components that must each exist in the final state and must
  be coordinated for integration, consistency, or joint acceptance, even when
  they form one product.
- Choose Reviewer only for an independent assessment of supplied or delegated
  work.
