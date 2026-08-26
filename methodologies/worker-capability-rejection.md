# Worker Capability Rejection

A settled capability failure establishes only that the exact invocation did
not complete its intended effect. It does not by itself establish that the
Worker objective is blocked.

When the failed result reports that no mutation occurred and supplies a
concrete diagnostic or correction hint, compare it with the attempted
invocation. If an offered capability can make a materially different,
corrected invocation within the same objective, invoke it from this same
Worker call before choosing `return_failure`.

Preserve successful settled work. Never repeat identical controls or a
rejected payload unchanged. Choose `return_failure` only when the supplied
facts establish that no authorized, materially different feasible invocation
remains.

When a later successful settled result establishes the same required external
outcome, treat an earlier failed attempt as historical evidence, not as a
remaining blocker. Assess completion from the currently established outcome,
not from whether every attempted invocation succeeded.

The selected action must match that assessment. If every requirement is
established, choose `return_result`; never choose `return_failure` while
stating that the objective is complete.
