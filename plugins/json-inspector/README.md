# JSON Inspector

Validates one UTF-8 JSON file and returns a bounded structural summary on Linux,
macOS and native Windows. Relative paths use the configured agent work directory;
`workspace/...` uses configured workspace sources. Absolute paths must stay
inside an authorized root. Request path restrictions still apply.

The shared limits remain 2 MiB of source, six levels of depth, 200 visited nodes
and 8,000 output characters. Invalid JSON is reported as a syntax observation;
invalid UTF-8, oversized files and unsafe paths fail without a partial summary.
The tool does not change the file.

## Windows requirements

The SDK uses built-in Windows PowerShell and its C# reader. No Companion,
WSL, Docker, elevation or execution-policy bypass is required. A blocked
reader reports `json_safe_read_unavailable` and tells the model not to retry
or bypass the restriction. Request cancellation stops the reader.
