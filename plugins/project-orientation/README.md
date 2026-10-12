# Project Orientation

Inspects a bounded directory tree and project manifest metadata on Linux, macOS
and native Windows. Relative paths use the configured agent work directory;
`workspace/...` selects configured workspace sources. Absolute paths retain
the same authorization boundary, including request-specific restrictions.

Package metadata uses the SDK's bounded reader (256 KiB maximum). Other known
manifest names are detected without reading their contents. Inspection never
executes package scripts or changes project files. Existing depth, entry,
script-name and output limits apply on every platform.

## Windows requirements

Built-in Windows PowerShell and its C# helper provide safe package-manifest
reading. No Companion, WSL, Docker, elevation or policy bypass is needed.
If the helper is blocked, `project_safe_read_unavailable` tells the model not
to retry or bypass the restriction. Cancellation stops the manifest read and
directory traversal.

A project without `package.json` can still be inspected without starting
the file-reading helper. Junctions or traversal outside the configured roots
are rejected by the same Runtime path resolver.
