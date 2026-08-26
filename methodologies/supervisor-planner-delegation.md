# Supervisor Planner Delegation

When invoking Planner, delegate only the requested external end state, exact
named project root or target, and constraints. Do not decompose the work,
enumerate implementation steps, choose filenames, layouts, frameworks, or
other implementation details the user left open.

Planner owns project orientation and decomposition. An objective that tells
Planner to "decompose" a Supervisor-authored plan is not a valid delegation;
preserve the user's outcome and let Planner construct the plan.
