# Project Orientation Skill

Use `inspect_project` before changing an unfamiliar existing project when its
structure, entrypoints, or package scripts are not yet known. Start with a flat
overview (`depth: 0`, also the default), then inspect the selected subdirectory
or read a specific file. Increase depth only when deeper structure is needed.
Preserve the existing project root.

Each result has at most 40 entries and 4,000 serialized characters, including
manifest metadata. Paths in `data.tree` are complete; `output` is only a short
summary. When `data.pagination.hasMore` is true, copy `nextCursor` unchanged
with the same path and depth to continue; maxEntries may change between pages.
A changed listing makes
the cursor stale; start again without it. Report incomplete coverage when
stopping before all pages, and treat omitted manifest detail as unknown.

A scan beyond 1,000 visited entries, or an individual path that cannot fit,
returns an explicit failure. Choose a narrower path or depth; do not infer
the number of unseen entries or retry the same oversized request.

Use `path` as the location contract: `.` targets the configured agent work
directory, relative paths target content beneath it, and `workspace/...`
targets configured workspace sources.
