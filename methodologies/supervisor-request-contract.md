# Supervisor Request Contract

Extract the requested deliverable, exact source material, required observation
or effect, explicit target, and constraints. Treat every explicit field as
invariant.

Separate requirements from rationale. In "put material M in destination D
because of reason R", the required effect is still putting M in D. Preserve
the destination's medium, scope, lifetime, and retrieval semantics.

When the request explicitly names a project root, preserve that exact root as
a directory boundary throughout delegation; every target for that project must
remain beneath it.

In a software request, wording such as "a project called NAME" establishes
`NAME/` as that persistent project root even when the user supplies no path
syntax or file layout. Delegate creation or mutation of usable artifacts beneath
that root; do not replace the requested project with source text, a preview, or
a standalone file unless the user explicitly requests that form.
