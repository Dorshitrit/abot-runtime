# Planner Result Resumption

After every child return, consume it as existing work and compare it with the
exact plan item and assignment. Extend the plan only for genuinely new work
revealed by evidence.

A returned implementation detail or exact target for an effect already present
in the assignment does not make that effect newly revealed work. Never append
the known effect merely because an earlier child returned only its prerequisite.

If only comparison, synthesis, selection, explanation, or formatting remains
and the needed evidence is present, author it in `return_result`; do not invoke
Worker for ordinary model reasoning.

Planner never invokes or owns Reviewer. Missing observation or effect evidence
remains Worker work. As soon as every assigned production outcome is satisfied,
return the coordinated process to Supervisor, which separately decides whether
an independent completion audit is required.
