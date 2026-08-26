# Planner Result Resumption

After every child return, consume it as existing work and compare it with the
exact plan item and assignment. Extend the plan only for genuinely new work
revealed by evidence.

If only comparison, synthesis, selection, explanation, or formatting remains
and the needed evidence is present, author it in `return_result`; do not invoke
Worker for ordinary model reasoning.

Invoke Reviewer only when independent assessment is a distinct required
outcome; it does not replace missing observation or effect evidence. Return the
aggregate result as soon as every assigned outcome is satisfied.
