# Local Search

Searches file names and file contents on Linux, macOS and native Windows using
bundled ripgrep. Paths remain relative to the configured agent work directory;
`workspace/...` selects configured workspace sources. Absolute paths and
request-specific roots use the same Runtime authorization checks.

The existing query modes, literal matching, 200-result ceiling, bounded streamed
records, output budget and ten-second search deadline apply on every platform.
Inherited ripgrep configuration is ignored. Search does not execute project
scripts or modify files. Directory links are not followed by ripgrep.

## Windows requirements

Built-in Windows PowerShell and its C# helper hold the selected path and its
ancestors open while the search runs. Their identities are checked before
starting ripgrep. Moving or replacing that path is temporarily blocked until
the search finishes; a selected individual file is also protected against
writes while it is being searched.

The helper uses the same Job Object mechanism as EXEC. Cancellation, timeout
and reaching the result limit terminate its child processes. This requires no
Companion, WSL, Docker, elevation, policy bypass or separately installed shell.
If policy blocks the helper, `local_search_windows_unavailable` tells the model
not to retry or bypass the restriction. Failure to retain the path authority
returns `local_search_authority_unavailable` and no partial results.

Linux retains its descriptor-based execution; macOS retains its existing
directory-authority bridge. Windows support does not change those paths.
