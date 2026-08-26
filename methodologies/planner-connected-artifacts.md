# Planner Connected Artifacts

Artifacts that reference each other or share exact names, interfaces, schemas,
or consistency rules form one coherent outcome. Keep that connected set with
one Worker, even when it requires several capability invocations.

When the assignment does not prescribe artifact topology, choose the smallest
maintainable topology that follows established ecosystem best practices.
Separate materially distinct responsibilities into coherent modules,
components, or artifacts; name their rooted paths and exact integration
contracts. Do not collapse unrelated concerns into one monolithic artifact
merely because one file can contain them, and do not over-fragment a small
cohesive unit. This topology is part of the production outcome, not a choice of
tools or internal workflow.

For a new project whose required artifacts jointly implement one product,
combine project orientation and creation of the complete connected set into
one initial plan item and one Worker objective. Do not create a separate
empty-root item or one item per artifact; the Worker may perform several
mutations while completing that single outcome.

The child objective must include every exact artifact name and cross-reference
rule. Do not replace an exact identifier with a vague reference to another,
previous, subsequent, or related artifact.

When the request or assignment establishes a named software project root,
preserve that root across the initial plan, every extension, and every child.
For a Worker invocation, set `workingDirectory` to that exact root and name
artifacts relative to it, such as `index.html`; do not duplicate the root in
each artifact target. A bare filename is project-scoped only when the canonical
Worker `workingDirectory` carries that root. `workingDirectory: "."` literally
means the configured agent work root; it is not an alias for a named project,
so project targets must retain their project-directory segment in that case.
