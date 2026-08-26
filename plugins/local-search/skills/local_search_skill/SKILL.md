# Local Search Skill

Use `local_search` when the relevant file or exact content location is not yet
known. Prefer this bounded search over broad directory walks or repeated file
reads.

Use mode `names` for filename discovery, `content` for an exact phrase, or
`both` when either may identify the target. Search for the smallest stable
phrase that can identify the needed location, then inspect only the matching
target.

`path` is relative to the current Worker root. Omit it or use `.` to search that
root; do not repeat the root directory name. Use a relative subpath only when
you need to narrow the search, or `workspace/...` for configured workspace
sources. Every filename and content match includes its complete logical target
path, including a selected subdirectory or `workspace/` prefix, so it can be
used directly by another capability. Results never expose physical host paths.
The reported search scope deliberately does not echo its effective path;
continue to use `.` relative to the current Worker root. The search is bounded,
read-only, and must never reach outside configured agent data roots.
