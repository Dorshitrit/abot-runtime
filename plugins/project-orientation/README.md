# Project Orientation

Inspects a bounded directory tree and project manifest metadata on Linux, macOS
and native Windows. Relative paths use the configured agent work directory;
`workspace/...` selects configured workspace sources. Absolute paths retain
the same authorization boundary, including request-specific restrictions.

Package metadata uses the SDK's bounded reader (256 KiB maximum). Other known
manifest names are detected without reading their contents. Inspection never
executes package scripts or changes project files. Script-name and manifest
read limits apply on every platform.

Inspection starts flat (`depth: 0`) unless explicitly configured or requested
otherwise. Each page contains at most 40 entries and the entire serialized
plugin result is limited to 4,000 characters, including metadata and the cursor.
The Runtime's transport envelope adds its own fields outside this plugin limit.
Explicit depth and maxEntries remain upper bounds within those limits. Full
paths appear in `data.tree`; output contains a short summary. Omitted manifest
details are marked, and path strings are never shortened.

Continue with `data.pagination.nextCursor` and the same path and depth until
`hasMore` is false and `nextCursor` is null; maxEntries may change between pages.
Pages use a sorted
listing and bind the cursor to the resolved root, query and listing fingerprint.
Changed listings return `project_cursor_stale` instead of silently skipping entries.
There are no retained directory handles or persisted cursor records.

Each invocation visits at most 1,000 directory entries, including ignored names.
A larger traversal returns `project_scan_limit` with narrower-target guidance;
it does not claim an unseen count or supply a partial-listing cursor. An entry
that cannot fit in an otherwise empty page returns `project_entry_exceeds_budget`.

## Windows requirements

Built-in Windows PowerShell and its C# helper provide safe package-manifest
reading. No Companion, WSL, Docker, elevation or policy bypass is needed.
If the helper is blocked, `project_safe_read_unavailable` tells the model not
to retry or bypass the restriction. Cancellation stops the manifest read and
directory traversal.

A project without `package.json` can still be inspected without starting
the file-reading helper. Junctions or traversal outside the configured roots
are rejected by the same Runtime path resolver.
